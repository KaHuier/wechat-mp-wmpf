from __future__ import annotations

import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import wechat_mp
from _wechat_mp.login import require_weixin_session
from _wechat_mp.models import OfficialAccountInfo, ProfileTarget
from _wechat_mp.runtime import OfficialAccount, WeChatRuntime
from _wechat_mp import runtime as runtime_module


def article(number: int) -> dict[str, object]:
    return {
        "account_name": "ACCOUNT_NAME",
        "account_id": "account-id",
        "msg_id": number,
        "item_index": 1,
        "title": f"Article {number}",
        "digest": "",
        "url": f"https://example.test/{number}",
        "cover_url": "",
        "publish_time": number,
    }


class FakeAsyncClient:
    next_calls = 0

    def __init__(self, cdp_url: str) -> None:
        self.cdp_url = cdp_url

    async def __aenter__(self) -> FakeAsyncClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def search(self, query: str, *, exact: bool = True) -> list[OfficialAccountInfo]:
        return [OfficialAccountInfo(name=query, user_name="account-id")]

    async def open_account(self, account: OfficialAccountInfo) -> ProfileTarget:
        return ProfileTarget(target_id="profile", url="profile://target", account=account)

    async def prepare_article_page(
        self,
        profile: ProfileTarget,
        *,
        refresh: bool = True,
    ) -> dict[str, object]:
        return {
            "state": {"offset": 10, "is_end": False},
            "articles": [article(1), article(2)],
        }

    async def next_article_page(
        self,
        profile: ProfileTarget,
        *,
        delay: float = 0.8,
    ) -> dict[str, object]:
        type(self).next_calls += 1
        return {
            "state": {"offset": 20, "is_end": True},
            "articles": [article(1), article(2), article(3)],
        }


class PublicApiTests(unittest.TestCase):
    def setUp(self) -> None:
        FakeAsyncClient.next_calls = 0

    def runtime(self) -> WeChatRuntime:
        value = WeChatRuntime(
            bootstrap_app_id="wx0000000000000000",
            wmpf_debugger_dir="WMPFDebugger",
        )
        value._started = True
        return value

    def test_module_exports_new_api(self) -> None:
        self.assertTrue(callable(wechat_mp.start_runtime))
        self.assertIs(wechat_mp.WeChatRuntime, WeChatRuntime)
        self.assertIs(wechat_mp.OfficialAccount, OfficialAccount)
        self.assertTrue(hasattr(wechat_mp, "ArticlePage"))
        self.assertTrue(hasattr(wechat_mp, "ArticleCollection"))

    @patch("_wechat_mp.runtime.AsyncWeChatMP", FakeAsyncClient)
    def test_search_returns_bound_accounts(self) -> None:
        runtime = self.runtime()
        account = runtime.search_one("ACCOUNT_NAME")
        self.assertIsInstance(account, OfficialAccount)
        self.assertEqual(account.name, "ACCOUNT_NAME")
        self.assertEqual(account.user_name, "account-id")
        self.assertEqual(account.to_dict()["name"], "ACCOUNT_NAME")

    @patch("_wechat_mp.runtime.AsyncWeChatMP", FakeAsyncClient)
    def test_article_pager_exposes_pages_and_deduplicates(self) -> None:
        account = self.runtime().search_one("ACCOUNT_NAME")
        pager = account.article_pages()
        first = pager.next_page()
        second = pager.next_page()
        self.assertEqual(first.number, 1)
        self.assertEqual([item.title for item in first], ["Article 1", "Article 2"])
        self.assertFalse(first.is_end)
        self.assertEqual(second.number, 2)
        self.assertEqual([item.title for item in second], ["Article 3"])
        self.assertTrue(second.is_end)
        self.assertEqual(
            set(second.__dataclass_fields__),
            {"number", "articles", "offset", "is_end"},
        )
        with self.assertRaises(StopIteration):
            pager.next_page()

    @patch("_wechat_mp.runtime.AsyncWeChatMP", FakeAsyncClient)
    def test_max_pages_counts_the_first_page(self) -> None:
        account = self.runtime().search_one("ACCOUNT_NAME")
        pages = list(account.article_pages(max_pages=1))
        self.assertEqual(len(pages), 1)
        self.assertEqual(FakeAsyncClient.next_calls, 0)

    @patch("_wechat_mp.runtime.AsyncWeChatMP", FakeAsyncClient)
    def test_collect_all_articles(self) -> None:
        account = self.runtime().search_one("ACCOUNT_NAME")
        result = account.collect_all_articles(delay=0)
        self.assertEqual(result.pages_loaded, 2)
        self.assertTrue(result.is_end)
        self.assertEqual([item.title for item in result.articles], [
            "Article 1",
            "Article 2",
            "Article 3",
        ])
        self.assertEqual(result.to_dict()["account"]["name"], "ACCOUNT_NAME")

    def test_old_collection_api_is_removed(self) -> None:
        runtime = self.runtime()
        self.assertFalse(hasattr(runtime, "collect_account"))
        self.assertFalse(hasattr(runtime, "collect_account_articles"))

    def test_launch_patch_process_is_removed(self) -> None:
        project = Path(__file__).resolve().parents[1]
        self.assertFalse((project / "tools" / "patch_launch_config.js").exists())
        runtime_source = (project / "_wechat_mp" / "runtime.py").read_text("utf-8")
        self.assertNotIn("patch_launch_config", runtime_source)
        self.assertNotIn("LAUNCH_PATCH_READY", runtime_source)

    def test_search_detach_offsets_are_keyed_by_version_and_hash(self) -> None:
        project = Path(__file__).resolve().parents[1]
        sha256 = "3211EE33FD42F96EDF8390E641AF671A47B77D03CC09C4723DAFDBAE5CF75665"
        config_path = (
            project / "tools" / "offsets" / "search_detach" / "25710"
            / f"{sha256}.json"
        )
        config = json.loads(config_path.read_text("utf-8"))
        self.assertEqual(config["version"], 25710)
        self.assertEqual(config["flueSha256"], sha256)
        self.assertEqual(
            set(config["offsets"]),
            {"valueInit", "dictSet", "invokeNative", "valueDestroy",
             "manager", "dispatchPoint", "bizKey"},
        )

        inventory = json.loads(
            (project / "tools" / "offsets" / "wmpf-runtimes.json").read_text("utf-8")
        )
        by_version = {item["version"]: item for item in inventory["runtimes"]}
        self.assertEqual(by_version[25710]["flueSha256"], sha256)
        self.assertEqual(
            by_version[25715]["flueSha256"],
            "5BAF4A84A41036CE5B2EF897D85029BDE9EE9965B4A69D4F5B594672821CAD56",
        )
        config_25715 = by_version[25715]["searchDetachConfig"]
        self.assertIsNotNone(config_25715)
        detach_25715 = json.loads(
            (project / "tools" / "offsets" / config_25715).read_text("utf-8")
        )
        self.assertEqual(detach_25715["version"], 25715)
        self.assertEqual(
            detach_25715["flueSha256"],
            by_version[25715]["flueSha256"],
        )
        self.assertEqual(detach_25715["offsets"]["invokeNative"], "0x280EAE0")
        xweb_25715 = json.loads(
            (
                project / "tools" / "offsets"
                / by_version[25715]["xwebControlConfig"]
            ).read_text("utf-8")
        )
        self.assertEqual(xweb_25715["version"], 25715)
        self.assertEqual(xweb_25715["offsets"]["dispatchPoint"], "0x3E67250")

    def test_invalid_page_limit(self) -> None:
        account = OfficialAccount(
            self.runtime(),
            OfficialAccountInfo(name="ACCOUNT_NAME"),
        )
        with self.assertRaises(ValueError):
            account.article_pages(max_pages=0)

    @patch("_wechat_mp.login.weixin_processes", return_value=[])
    def test_runtime_requires_weixin_to_be_running(self, _processes) -> None:
        events: list[tuple[str, str]] = []
        with self.assertRaisesRegex(RuntimeError, "Weixin is not signed in or the login state is not ready"):
            require_weixin_session(
                status=lambda state, message: events.append((state, message)),
            )
        self.assertEqual(events, [])

    @patch("_wechat_mp.runtime._visible_wmpf_windows", side_effect=[[], [100]])
    @patch("_wechat_mp.runtime._open_search_native")
    @patch("_wechat_mp.runtime._find_wmpf_root")
    def test_runtime_bootstraps_a_search_wmpf_root(
        self,
        find_root,
        open_search,
        _visible_windows,
    ) -> None:
        root = SimpleNamespace(pid=123)
        find_root.side_effect = [None, root, root, root]
        found, search_opened = runtime_module._ensure_wmpf_root(1.0, lambda *_: None)
        self.assertIs(found, root)
        self.assertTrue(search_opened)
        open_search.assert_called_once_with(None)

    @patch("_wechat_mp.runtime._ui_thread_id", return_value=456)
    @patch("_wechat_mp.runtime._find_wmpf_root", return_value=SimpleNamespace(pid=123))
    @patch("_wechat_mp.runtime._open_search_native")
    @patch("_wechat_mp.runtime._visible_wmpf_windows", side_effect=[[], [100]])
    @patch("_wechat_mp.runtime._close_search_targets", return_value=1)
    @patch("_wechat_mp.runtime._cdp_has_target", side_effect=[False, True])
    @patch("_wechat_mp.runtime.subprocess.run")
    @patch("_wechat_mp.runtime.shutil.which", return_value="node")
    def test_search_opens_when_no_bootstrap_search(
        self,
        _which,
        run,
        _has_target,
        close_search_targets,
        _visible_windows,
        open_search,
        _find_root,
        _thread_id,
    ) -> None:
        run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        runtime = WeChatRuntime(
            bootstrap_app_id="wx0000000000000000",
            wmpf_debugger_dir="WMPFDebugger",
        )
        runtime._ensure_search_target()
        open_search.assert_called_once_with(runtime.debugger_dir)
        close_search_targets.assert_called_once_with(runtime.cdp_url, keep_primary=True)
        self.assertEqual(runtime._search_window_handles, {100})

    @patch("_wechat_mp.runtime._ui_thread_id", return_value=456)
    @patch("_wechat_mp.runtime._find_wmpf_root", return_value=SimpleNamespace(pid=123))
    @patch("_wechat_mp.runtime._visible_wmpf_windows", return_value=[])
    @patch("_wechat_mp.runtime._close_search_targets", return_value=0)
    @patch("_wechat_mp.runtime._cdp_has_target", side_effect=[False, True])
    @patch("_wechat_mp.runtime.subprocess.run")
    @patch("_wechat_mp.runtime.shutil.which", return_value="node")
    @patch("_wechat_mp.runtime._open_search_native")
    def test_search_reuses_bootstrap_window_without_second_add_tab(
        self,
        open_search,
        _which,
        run,
        _has_target,
        _close_targets,
        _visible_windows,
        _find_root,
        _thread_id,
    ) -> None:
        run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        runtime = WeChatRuntime(
            bootstrap_app_id="wx0000000000000000",
            wmpf_debugger_dir="WMPFDebugger",
        )
        runtime._ensure_search_target(search_opened=True)
        open_search.assert_not_called()

    @patch("_wechat_mp.runtime._cdp_close_target", return_value=True)
    @patch("_wechat_mp.runtime._cdp_request")
    def test_search_target_cleanup_keeps_only_result_target(
        self,
        request,
        close_target,
    ) -> None:
        request.return_value = {
            "result": {
                "targetInfos": [
                    {
                        "type": "page",
                        "targetId": "result",
                        "url": runtime_module.SEARCH_URI,
                    },
                    {
                        "type": "page",
                        "targetId": "home",
                        "url": runtime_module.SEARCH_MARKER + "?scene=243",
                    },
                ]
            }
        }
        closed = runtime_module._close_search_targets(
            "ws://127.0.0.1:62000",
            keep_primary=True,
        )
        self.assertEqual(closed, 1)
        close_target.assert_called_once_with("ws://127.0.0.1:62000", "home")

    @patch("_wechat_mp.runtime._close_window_handles", return_value=1)
    @patch("_wechat_mp.runtime._close_search_targets", return_value=2)
    def test_runtime_close_closes_all_search_targets(
        self,
        close_search_targets,
        close_windows,
    ) -> None:
        events = []
        runtime = WeChatRuntime(
            bootstrap_app_id="wx0000000000000000",
            wmpf_debugger_dir="WMPFDebugger",
            status_callback=events.append,
        )
        runtime._started = True
        runtime._search_window_handles = {100}
        runtime.close()
        close_search_targets.assert_called_once_with(runtime.cdp_url, keep_primary=False)
        close_windows.assert_called_once_with({100})
        self.assertFalse(runtime._started)
        self.assertEqual(events[0].state, "SEARCH_CLOSED")
        self.assertEqual(events[0].message, "targets=2 windows=1")

    def test_cli_has_no_framework_output_path(self) -> None:
        import run as cli

        with patch("sys.argv", ["run.py", "--account", "ACCOUNT_NAME"]):
            args = cli.parse_args()
        self.assertFalse(hasattr(args, "output"))

    def test_cli_collect_uses_current_runtime_signature(self) -> None:
        import run as cli

        args = SimpleNamespace(
            account="ACCOUNT_NAME",
            account_user_name="",
            delay=0.0,
            bootstrap_app_id="wx0000000000000000",
            startup_timeout=1.0,
        )
        with patch("run.wechat_mp.start_runtime") as start_runtime:
            client = MagicMock()
            start_runtime.return_value.__enter__.return_value = client
            account = MagicMock()
            account.collect_all_articles.return_value = "result"
            client.search_one.return_value = account
            self.assertEqual(cli.collect(args), "result")
        _, kwargs = start_runtime.call_args
        self.assertNotIn("weixin_path", kwargs)
        self.assertNotIn("login_timeout", kwargs)
        self.assertEqual(kwargs["bootstrap_app_id"], "wx0000000000000000")
        self.assertEqual(kwargs["startup_timeout"], 1.0)


if __name__ == "__main__":
    unittest.main()
