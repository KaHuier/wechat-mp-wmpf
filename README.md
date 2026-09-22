# wechat-mp-wmpf

## 项目说明

这是一个 Windows 本地项目，通过 WMPF/XWeb CDP 搜索并采集公众号文章。

## 开源致谢

本项目直接集成并复用了 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)，副本位于 [`vendor/WMPFDebugger`](vendor/WMPFDebugger)。重新发布时请遵守 [`vendor/WMPFDebugger/LICENSE`](vendor/WMPFDebugger/LICENSE)。

## 为什么先启动引导小程序

桌面客户端启动后，Search/Profile 不会自动提供外部 Browser CDP 端点。引导小程序用于建立 WMPF Remote Debug 通道：

1. WMPFDebugger 监听 9421。
2. XWeb.LaunchApplet 创建引导小程序并注入 remote_debug_endpoint=ws://127.0.0.1:9421。
3. 小程序连接后创建 Remote Debug 会话，WMPFDebugger 将原始 CDP 转发到 62000。
4. 项目随后调用原生 AddTab 创建 Search，绑定 Search/Profile，并通过 CDP 操作页面。

引导小程序只负责传输握手，公众号数据来自 Search/Profile 页面。

## 环境

- Windows 10/11
- Python 3.13 与 uv
- Node.js 22+
- 统一版 Weixin.exe
- WMPF runtime 25710 / 25715
- 可正常打开的引导小程序 App ID

```powershell
uv sync
```

## Python API

```python
import json
import wechat_mp

with wechat_mp.start_runtime(bootstrap_app_id="APP_ID") as client:
    account = client.search_one("公众号名称")
    result = account.collect_all_articles()
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
```

逐页处理并在每页之间插入调试或保存逻辑：

```python
with wechat_mp.start_runtime(bootstrap_app_id="APP_ID") as client:
    account = client.search_one("公众号名称")
    for page in account.article_pages():
        print(page.number, len(page.articles), page.is_end)
        for article in page.articles:
            print(article.title, article.url, article.digest)
```

`article_pages(max_pages=N)` 的页数包含第一页；`None` 表示迭代到最后一页。返回的分页器也可以手动调用 `next_page()`。`Article` 当前包含标题、摘要、URL、封面和发布时间等 Profile 元数据，不包含文章正文。

## 客户端路径

运行时会自动查找客户端，也可以通过 `weixin_path` 手动指定路径。

```python
with wechat_mp.start_runtime(
    bootstrap_app_id="APP_ID",
    weixin_path=r"D:\\Tencent\\Weixin\\Weixin.exe",
) as client:
    print(client.search("公众号名称"))
```

## 自动启动流程

运行时会检查客户端进程和登录状态，启动或连接 WMPFDebugger，启用 XWeb WebSocket，启动引导小程序，建立 CDP，并绑定 Search/Profile 目标。

## 命令行

```powershell
uv run python run.py --help
```

## 版本约束

当前已适配 WMPF runtime `25710` 和 `25715`。Search detach 与 XWeb 控制偏移会按照 runtime 版本及 `flue.dll` SHA256 精确加载，配置位于 [`tools/offsets`](tools/offsets)；其他版本或文件哈希不匹配时会停止启动，避免误用偏移。

## 后续版本方向

前期实验形成了两个可以继续推进的技术方向。

### 方向一：完善现有的引导小程序通道

继续使用已经跑通的 `WMPFDebugger + 引导小程序 + 原始 CDP` 链路，将实验脚本收敛为稳定运行时：

1. 自动发现客户端进程、WMPF UI 线程和动态 XWeb WebSocket 端口。
2. 通过 `XWeb.LaunchApplet` 冷启动引导小程序，并自动注入 Remote Debug 配置。
3. 自动建立 `9421 → 62000` 通道，检测断线并重新连接。
4. 通过原生 `AddTab` 创建 Search，按 URL 精确绑定 Search/Profile WebContents。
5. 将搜索公众号、选择精确账号、打开主页、分页和文章提取统一封装为 Python API。
6. 为不同 WMPF runtime 版本维护独立地址配置，按版本及 `flue.dll` SHA256 校验后加载。

该方向的优势是已有完整采集链路，适合优先提高自动化程度、容错能力和版本兼容性。

### 方向二：直接暴露底层标准 DevTools/CDP

继续定位 XWeb 内部创建 `DevToolsAgentHost`、CDP Session 和 DevTools Socket Server 的位置，让 Search/Profile 直接监听标准 DevTools WebSocket：

1. 绕开 XWeb-use 接口的方法白名单，不再由适配器逐条转发 CDP method。
2. 提供标准的 `/json/version`、`/json/list` 和 `/devtools/page/<target-id>` 端点。
3. 让 Chrome DevTools 直接显示 Elements、Network、Console、Sources 等面板。
4. 让 Playwright 能发现 BrowserContext 和 Page，而不是只连接到一个原始 CDP 会话。
5. 研究 Search 页面打开第二个 Profile WebContents 后的 Target 创建、枚举和切换机制。

此前的 DevTools 适配实验已经能够返回 `DOM.getDocument`，但 `Runtime.callFunctionOn`、`DOM.resolveNode`、`CSS.getComputedStyleForNode`、`Page.reload` 等方法会被 XWeb-use 白名单拒绝。因此，单纯补充转发适配器只能实现有限的 DOM Inspector；若要获得完整 DevTools，应继续下沉到 XWeb 的原生 DevTools Agent Host 和 Socket 层。
