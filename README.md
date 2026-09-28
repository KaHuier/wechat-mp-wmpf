# wechat-mp-wmpf

Windows 本地微信公众号采集工具。项目通过微信 WMPF/XWeb、Frida 与 CDP 操作搜一搜和公众号主页，支持公众号搜索、文章列表分页和自定义采集流程。

关键词：`wechat`、`wechat-mp`、`wechat-mp-wmpf`、`wechat-collector`、`微信公众号采集`、`WMPF`、`WMPFDebugger`、`CDP`。

> 📌 **注意事项**
>
> 本项目为科研辅助工具，面向学术研究、课程项目和个人学习场景。
>
> 使用者应遵守微信平台服务协议、《网络安全法》及相关法律法规，合理处理公开文章材料、引用方式和研究结果。
>
> 使用过程中涉及的法律、平台规则和研究伦理责任由使用者自行承担。

## 环境要求

- Windows 10/11
- Python 3.13 与 uv
- Node.js 22+
- 已启动并登录的统一版 `Weixin.exe`
- WMPF runtime 25710 或 25715
- 一个能够正常启动的引导小程序 App ID
- [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)

## 安装

安装 Python 依赖：

```powershell
uv sync
```

下载 WMPFDebugger 并安装其依赖：

```powershell
git clone https://github.com/evi0s/WMPFDebugger D:\tools\WMPFDebugger
Set-Location D:\tools\WMPFDebugger
npm install
```

项目不内置 WMPFDebugger。可以在 Python 中传入路径，也可以设置 `WMPF_DEBUGGER_DIR` 环境变量。

## 快速开始

```python
import json

import wechat_mp


with wechat_mp.start_runtime(
    bootstrap_app_id="APP_ID",
    wmpf_debugger_dir=r"D:\tools\WMPFDebugger",
) as client:
    account = client.search_one("公众号名称")
    result = account.collect_all_articles()
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
```

运行前需要由用户自行启动并登录微信；框架不会启动或登录微信。

## 分页处理

```python
import wechat_mp


with wechat_mp.start_runtime(
    bootstrap_app_id="APP_ID",
    wmpf_debugger_dir=r"D:\tools\WMPFDebugger",
) as client:
    account = client.search_one("公众号名称")

    for page in account.article_pages():
        print(page.number, page.offset, page.is_end)

        for article in page.articles:
            print(article.title, article.url, article.digest)
```

- `article_pages(max_pages=N)`：最多读取 N 页，第一页计入页数。
- `article_pages(max_pages=None)`：持续读取到最后一页。
- `collect_all_articles()`：读取全部分页后一次性返回 `ArticleCollection`。
- `Article` 包含标题、摘要、URL、封面和发布时间等公众号主页元数据，不包含文章正文。
- 数据保存不由框架负责，用户可以在逐页循环中自行写入数据库或文件。

## 启动链路

1. 检查微信进程和当前登录账号。
2. 选择现有 WMPF 根进程。
3. 校验 WMPF runtime 版本。
4. 启动调试桥，并通过 `XWeb.LaunchApplet(headless=1)` 建立不可见的 Remote Debug 会话。
5. 使用原生 AddTab 打开搜一搜并将其绑定到 CDP。
6. 通过 Search/Profile Target 执行搜索和文章分页。
7. 退出 `with` 时关闭框架创建的搜一搜 Target 和调试器进程，不退出微信。

## 版本适配

当前支持：

| WMPF runtime |
| --- |
| 25710 |
| 25715 |

Search detach 和 XWeb 控制偏移按照 WMPF runtime 版本加载，配置位于 [`tools/offsets`](tools/offsets)。不支持的 runtime 版本会停止启动，避免使用错误偏移。

## 命令行

```powershell
uv run python run.py --help
```
