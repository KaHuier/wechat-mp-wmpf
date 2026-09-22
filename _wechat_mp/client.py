from __future__ import annotations

import asyncio
import json
from typing import Any, Protocol
from urllib.parse import parse_qs, urlencode, urlparse

from .cdp import CdpConnection, CdpError
from .models import OfficialAccountInfo, ProfileTarget

CDP_URL = "ws://127.0.0.1:62000"
SEARCH_MARKER = "weixin://resourceid/Search/app.html"
PROFILE_MARKER = "weixin://resourceid/SubscriptionProfile/profile.html"
SEARCH_URI = SEARCH_MARKER + "?isHomePage=1&lang=zh_CN&scene=243&type=0"


class CdpTransport(Protocol):
    async def open(self) -> Any: ...
    async def close(self) -> None: ...
    async def targets(self) -> list[dict[str, Any]]: ...
    async def attach(self, target_id: str) -> str: ...
    async def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]: ...
    async def evaluate_json(
        self, session_id: str, expression: str, *, timeout: float = 40.0
    ) -> dict[str, Any]: ...


SEARCH_RESULTS_JS = r"""
/*WECHAT_MP_SEARCH_RESULTS*/
(() => {
  const accounts=[];
  const seen=new Set();
  for (const element of document.querySelectorAll("*")) {
    const component=element.__vue__;
    if (!component || !component.$options || component.$options.name !== "UnifiedAccount") continue;
    const item=component.item||{};
    const jump=item.jumpInfo||{};
    const key=String(jump.userName||jump.bizuin||jump.nickName||"");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    accounts.push({name:jump.nickName||"",user_name:jump.userName||"",
      alias:jump.aliasName||"",bizuin:String(jump.bizuin||item.docID||""),
      signature:jump.signature||""});
  }
  return JSON.stringify({ok:true,ready:document.readyState === "complete" && accounts.length > 0,accounts});
})()
"""

SEARCH_SUGGESTION_JS = r"""
/*WECHAT_MP_SEARCH_SUGGESTION*/
(() => {
  const expected=__QUERY__;
  for (const element of document.querySelectorAll("[data-sug-id]")) {
    const value=String(element.getAttribute("data-sug-id")||"");
    if (value.includes(`|${expected}|`))
      return JSON.stringify({ok:true,suggestion_id:value});
  }
  return JSON.stringify({ok:true,suggestion_id:""});
})()
"""

RANGE_JS = r"""
/*WECHAT_MP_PROFILE_RANGE*/
(() => {
  const page=[...document.querySelectorAll("*")].map(e=>e.__vue__).find(
    v=>v && v.$options && v.$options.name === "ProfilePage");
  if (!page) return JSON.stringify({ok:false});
  const times=[];
  for (const group of page.allList||[]) {
    const base=group.BaseInfo||{};
    const app=group.AppMsg||{};
    for (const detail of app.DetailInfo||[]) {
      const value=Number(detail.send_time||base.DateTime||(app.BaseInfo||{}).CreateTime||0);
      if (value > 0) times.push(value);
    }
  }
  return JSON.stringify({ok:true,groups:(page.allList||[]).length,
    offset:page.offsetInfo&&page.offsetInfo.Offset,
    oldest:times.length?Math.min(...times):null,
    newest:times.length?Math.max(...times):null,
    is_end:Boolean(page.offsetInfo&&page.offsetInfo.IsEnd)});
})()
"""

REFRESH_JS = r"""
/*WECHAT_MP_PROFILE_REFRESH*/
(async () => {
  const nodes=[...document.querySelectorAll("*")].map(e=>e.__vue__).filter(Boolean);
  const page=nodes.find(v=>v.$options&&v.$options.name === "ProfilePage");
  const profile=nodes.find(v=>v.$options&&v.$options.name === "Profile");
  if (!page || !profile || !profile.profileAccount)
    return JSON.stringify({ok:false,error:"profile Vue components missing"});
  const outcome=await new Promise(resolve=>{
    let done=false;
    const finish=value=>{if(!done){done=true;resolve(value);}};
    profile.$store.dispatch("getBizProfile",{item:profile.profileAccount,
      notFirstScreen:false,actionType:0,vm:profile,cb(){finish({callback:true});}});
    setTimeout(()=>finish({timeout:true}),20000);
  });
  await new Promise(resolve=>setTimeout(resolve,250));
  return JSON.stringify({ok:!outcome.timeout,outcome,groups:(page.allList||[]).length,
    offset:page.offsetInfo&&page.offsetInfo.Offset,
    is_end:Boolean(page.offsetInfo&&page.offsetInfo.IsEnd)});
})()
"""

NEXT_JS = r"""
/*WECHAT_MP_PROFILE_NEXT*/
(async () => {
  const nodes=[...document.querySelectorAll("*")].map(e=>e.__vue__).filter(Boolean);
  const page=nodes.find(v=>v.$options&&v.$options.name === "ProfilePage");
  const profile=nodes.find(v=>v.$options&&v.$options.name === "Profile");
  if (!page || !profile) return JSON.stringify({ok:false,error:"Vue components missing"});
  const before={groups:(page.allList||[]).length,offset:page.offsetInfo&&page.offsetInfo.Offset,
    is_end:Boolean(page.offsetInfo&&page.offsetInfo.IsEnd)};
  if (before.is_end) return JSON.stringify({ok:true,end:true,before,after:before});
  profile.getNextPageData();
  const started=Date.now();
  while (Date.now()-started < 20000) {
    await new Promise(resolve=>setTimeout(resolve,100));
    const after={groups:(page.allList||[]).length,offset:page.offsetInfo&&page.offsetInfo.Offset,
      is_end:Boolean(page.offsetInfo&&page.offsetInfo.IsEnd)};
    if (after.groups !== before.groups || after.offset !== before.offset || after.is_end)
      return JSON.stringify({ok:true,end:after.is_end,before,after});
  }
  return JSON.stringify({ok:false,error:"pagination timeout",before});
})()
"""

EXTRACT_JS = r"""
/*WECHAT_MP_PROFILE_EXTRACT*/
(() => {
  const page=[...document.querySelectorAll("*")].map(e=>e.__vue__).find(
    v=>v&&v.$options&&v.$options.name === "ProfilePage");
  if (!page) return JSON.stringify({ok:false,error:"ProfilePage missing"});
  const query=new URL(location.href).searchParams;
  const groups=[...((page.featuredMsg&&page.featuredMsg.featuredList)||[]),...(page.allList||[])];
  const articles=[];
  const seen=new Set();
  for (const group of groups) {
    const groupBase=group.BaseInfo||{};
    const app=group.AppMsg||{};
    const appBase=app.BaseInfo||{};
    for (const detail of app.DetailInfo||[]) {
      if (!detail||!detail.ContentUrl) continue;
      let url=String(detail.ContentUrl).replace(/^http:/,"https:");
      try {const parsed=new URL(url);parsed.searchParams.delete("scene");
        parsed.searchParams.delete("sessionid");parsed.hash="";url=parsed.toString();} catch (_) {}
      const key=url||`${groupBase.MsgId||appBase.AppMsgId}:${detail.ItemIndex||1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      articles.push({account_name:query.get("showName")||document.title||"",
        account_id:query.get("userName")||"",msg_id:groupBase.MsgId||appBase.AppMsgId||null,
        item_index:detail.ItemIndex||1,title:detail.Title||"",digest:detail.Digest||"",url,
        cover_url:detail.CoverImgUrl||"",
        publish_time:detail.send_time||groupBase.DateTime||appBase.CreateTime||null});
    }
  }
  return JSON.stringify({ok:true,is_end:Boolean(page.offsetInfo&&page.offsetInfo.IsEnd),articles});
})()
"""


class WeChatMP:
    """High-level official-account API over the WMPFDebugger CDP bridge."""

    def __init__(
        self,
        cdp_url: str = CDP_URL,
        *,
        transport: CdpTransport | None = None,
    ) -> None:
        self.cdp_url = cdp_url
        self._cdp: CdpTransport = transport or CdpConnection(cdp_url)
        self._owns_transport = transport is None
        self._search_session_id = ""
        self._profile: ProfileTarget | None = None

    async def __aenter__(self) -> WeChatMP:
        if self._owns_transport:
            await self._cdp.open()
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._owns_transport:
            await self._cdp.close()

    async def targets(self) -> list[dict[str, Any]]:
        return await self._cdp.targets()

    async def search(
        self,
        query: str,
        *,
        exact: bool = True,
        timeout: float = 25.0,
    ) -> list[OfficialAccountInfo]:
        query = query.strip()
        if not query:
            raise ValueError("query must not be empty")
        search_targets = [
            item
            for item in await self.targets()
            if item.get("type") == "page" and SEARCH_MARKER in str(item.get("url") or "")
        ]
        search_target = next(
            (
                item
                for item in reversed(search_targets)
                if "type=0" in str(item.get("url") or "")
            ),
            search_targets[-1] if search_targets else None,
        )
        if not search_target:
            raise CdpError("Search target is missing; establish the bootstrap channel and detach Search")
        self._search_session_id = await self._cdp.attach(str(search_target["targetId"]))
        await self._cdp.evaluate_json(
            self._search_session_id,
            """(() => { const input=document.querySelector('#weixin-search-input');
            if (!input) return JSON.stringify({ok:false});
            const value=__QUERY__;
            input.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
            input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
            return JSON.stringify({ok:true}); })()""".replace(
                "__QUERY__", json.dumps(query, ensure_ascii=False)
            ),
        )

        suggestion_id = ""
        suggestion_expression = SEARCH_SUGGESTION_JS.replace(
            "__QUERY__", json.dumps(query, ensure_ascii=False)
        )
        suggestion_deadline = asyncio.get_running_loop().time() + min(10.0, timeout)
        while asyncio.get_running_loop().time() < suggestion_deadline:
            suggestion = await self._cdp.evaluate_json(
                self._search_session_id,
                suggestion_expression,
            )
            suggestion_id = str(suggestion.get("suggestion_id") or "")
            if suggestion_id:
                break
            await asyncio.sleep(0.2)
        if not suggestion_id:
            raise CdpError(f"search suggestion did not appear for {query!r}")
        click_expression = """(() => {
          const expected=__SUGGESTION__;
          const element=[...document.querySelectorAll('[data-sug-id]')].find(
            item => item.getAttribute('data-sug-id') === expected);
          if (!element) return JSON.stringify({ok:false,clicked:false});
          element.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          element.click();
          return JSON.stringify({ok:true,clicked:true});
        })()""".replace("__SUGGESTION__", json.dumps(suggestion_id))
        clicked = await self._cdp.evaluate_json(
            self._search_session_id,
            click_expression,
        )
        if not clicked.get("clicked"):
            raise CdpError(f"failed to click search suggestion for {query!r}")

        deadline = asyncio.get_running_loop().time() + timeout
        accounts: list[OfficialAccountInfo] = []
        while asyncio.get_running_loop().time() < deadline:
            payload = await self._cdp.evaluate_json(self._search_session_id, SEARCH_RESULTS_JS)
            accounts = [OfficialAccountInfo.from_dict(item) for item in payload.get("accounts") or []]
            if accounts:
                break
            await asyncio.sleep(0.25)
        if exact:
            key = query.casefold()
            accounts = [account for account in accounts if account.name.strip().casefold() == key]
        return accounts

    async def open_account(
        self,
        account: OfficialAccountInfo | str,
        *,
        user_name: str = "",
        timeout: float = 25.0,
    ) -> ProfileTarget:
        if isinstance(account, str):
            matches = await self.search(account, exact=True, timeout=timeout)
            if user_name:
                matches = [item for item in matches if item.user_name == user_name]
            if len(matches) != 1:
                raise CdpError(
                    f"expected one exact account for {account!r}, got {len(matches)}; "
                    "select by user_name when names collide"
                )
            selected = matches[0]
        else:
            selected = account
            if not self._search_session_id:
                await self.search(selected.name, exact=True, timeout=timeout)

        identity = json.dumps(
            {"name": selected.name, "user_name": selected.user_name}, ensure_ascii=False
        )
        click_js = f"""
/*WECHAT_MP_OPEN_ACCOUNT*/
(() => {{
  const expected={identity};
  for (const element of document.querySelectorAll("*")) {{
    const component=element.__vue__;
    if (!component||!component.$options||component.$options.name !== "UnifiedAccount") continue;
    const jump=(component.item&&component.item.jumpInfo)||{{}};
    if (jump.nickName === expected.name && (!expected.user_name||jump.userName === expected.user_name)) {{
      element.click();
      return JSON.stringify({{ok:true,clicked:true}});
    }}
  }}
  return JSON.stringify({{ok:false,clicked:false}});
}})()
"""
        clicked = await self._cdp.evaluate_json(self._search_session_id, click_js)
        if not clicked.get("clicked"):
            raise CdpError(f"failed to click official account {selected.name!r}")

        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            for target in reversed(await self.targets()):
                if self._profile_matches(target, selected):
                    self._profile = ProfileTarget(
                        target_id=str(target["targetId"]),
                        url=str(target.get("url") or ""),
                        account=selected,
                    )
                    return self._profile
            await asyncio.sleep(0.25)
        raise CdpError(f"profile target did not appear for {selected.name!r}")

    async def prepare_article_page(
        self,
        profile: ProfileTarget,
        *,
        refresh: bool = True,
    ) -> dict[str, Any]:
        session_id = await self._cdp.attach(profile.target_id)
        state: dict[str, Any] = {}
        for _ in range(100):
            state = await self._cdp.evaluate_json(session_id, RANGE_JS)
            if state.get("ok"):
                break
            await asyncio.sleep(0.25)
        else:
            raise CdpError("official-account profile did not initialize")

        if refresh:
            refreshed = await self._cdp.evaluate_json(session_id, REFRESH_JS)
            if not refreshed.get("ok"):
                raise CdpError(f"profile refresh failed: {refreshed}")
            state = await self._cdp.evaluate_json(session_id, RANGE_JS)
        return await self._article_page_snapshot(session_id, state)

    async def next_article_page(
        self,
        profile: ProfileTarget,
        *,
        delay: float = 0.8,
    ) -> dict[str, Any]:
        session_id = await self._cdp.attach(profile.target_id)
        state = await self._cdp.evaluate_json(session_id, RANGE_JS)
        if not state.get("ok"):
            raise CdpError(f"profile state unavailable: {state}")
        if state.get("is_end"):
            return await self._article_page_snapshot(session_id, state)
        step = await self._cdp.evaluate_json(session_id, NEXT_JS)
        if not step.get("ok"):
            raise CdpError(f"pagination failed: {step}")
        await asyncio.sleep(max(0.0, delay))
        state = await self._cdp.evaluate_json(session_id, RANGE_JS)
        if not state.get("ok"):
            raise CdpError(f"profile state unavailable after pagination: {state}")
        return await self._article_page_snapshot(session_id, state)

    async def _article_page_snapshot(
        self,
        session_id: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        result = await self._cdp.evaluate_json(session_id, EXTRACT_JS, timeout=60.0)
        if not result.get("ok"):
            raise CdpError(f"article extraction failed: {result}")
        return {"state": state, "articles": result.get("articles") or []}

    @staticmethod
    def _profile_matches(target: dict[str, Any], account: OfficialAccountInfo) -> bool:
        url = str(target.get("url") or "")
        if target.get("type") != "page" or PROFILE_MARKER not in url:
            return False
        query = parse_qs(urlparse(url).query)
        name = str((query.get("showName") or [""])[0]).strip().casefold()
        user_name = str((query.get("userName") or [""])[0]).strip().casefold()
        if name != account.name.strip().casefold():
            return False
        return not account.user_name or user_name == account.user_name.strip().casefold()


def connect(cdp_url: str = CDP_URL) -> WeChatMP:
    """Return an async context manager connected to an established bridge."""
    return WeChatMP(cdp_url)


async def search(
    query: str,
    *,
    cdp_url: str = CDP_URL,
    exact: bool = True,
) -> list[OfficialAccountInfo]:
    """One-shot module API: ``await wechat_mp.search('name')``."""
    async with WeChatMP(cdp_url) as client:
        return await client.search(query, exact=exact)
