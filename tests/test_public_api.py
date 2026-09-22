from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import wechat_mp
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
        value = WeChatRuntime(bootstrap_app_id="wx0000000000000000")
        value._started = True
        return value

    def test_module_exports_new_api(self) -> None:
        self.assertTrue(callable(wechat_mp.start_runtime))
        self.assertTrue(callable(wechat_mp.find_weixin_executable))
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

    def test_invalid_page_limit(self) -> None:
        account = OfficialAccount(
            self.runtime(),
            OfficialAccountInfo(name="ACCOUNT_NAME"),
        )
        with self.assertRaises(ValueError):
            account.article_pages(max_pages=0)

    def test_explicit_executable_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "Weixin.exe"
            executable.touch()
            self.assertEqual(
                wechat_mp.find_weixin_executable(executable),
                executable.resolve(),
            )

    @patch("_wechat_mp.runtime._open_search_native")
    @patch("_wechat_mp.runtime._find_wmpf_root")
    def test_cold_start_marks_search_as_already_opened(
        self,
        find_root,
        open_search,
    ) -> None:
        root = SimpleNamespace(pid=123)
        find_root.side_effect = [None, root, root]
        found, search_opened = runtime_module._ensure_wmpf_root(1.0, lambda *_: None)
        self.assertIs(found, root)
        self.assertTrue(search_opened)
        open_search.assert_called_once_with()

    @patch("_wechat_mp.runtime._open_search_native")
    @patch("_wechat_mp.runtime._visible_wmpf_windows", side_effect=[[], [100]])
    @patch("_wechat_mp.runtime._close_search_targets", return_value=1)
    @patch("_wechat_mp.runtime._ui_thread_id", return_value=456)
    @patch("_wechat_mp.runtime._find_wmpf_root")
    @patch("_wechat_mp.runtime._cdp_has_target", side_effect=[False, True])
    @patch("_wechat_mp.runtime.subprocess.run")
    @patch("_wechat_mp.runtime.shutil.which", return_value="node")
    def test_detach_reuses_search_opened_during_cold_start(
        self,
        _which,
        run,
        _has_target,
        find_root,
        _thread_id,
        close_search_targets,
        _visible_windows,
        open_search,
    ) -> None:
        run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        find_root.return_value = SimpleNamespace(pid=123)
        runtime = WeChatRuntime(bootstrap_app_id="wx0000000000000000")
        runtime._ensure_search_target(search_opened=True)
        open_search.assert_not_called()
        close_search_targets.assert_called_once_with(runtime.cdp_url, keep_primary=True)
        self.assertEqual(runtime._search_window_handles, {100})

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


if __name__ == "__main__":
    unittest.main()
