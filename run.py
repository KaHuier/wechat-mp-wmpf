from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import wechat_mp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="WMPF CDP account collector")
    parser.add_argument("--account", required=True)
    parser.add_argument("--account-user-name", default="")
    parser.add_argument("--delay", type=float, default=0.8)
    parser.add_argument("--bootstrap-app-id", default=os.getenv("WMPF_BOOTSTRAP_APP_ID", ""))
    parser.add_argument("--weixin-path", type=Path)
    parser.add_argument("--login-timeout", type=float, default=300.0)
    parser.add_argument("--startup-timeout", type=float, default=45.0)
    return parser.parse_args()


def collect(args: argparse.Namespace) -> wechat_mp.ArticleCollection:
    with wechat_mp.start_runtime(
        bootstrap_app_id=args.bootstrap_app_id,
        weixin_path=args.weixin_path,
        login_timeout=args.login_timeout,
        startup_timeout=args.startup_timeout,
    ) as client:
        account = client.search_one(
            args.account,
            user_name=args.account_user_name,
        )
        return account.collect_all_articles(delay=args.delay)


def main() -> None:
    args = parse_args()
    if not args.bootstrap_app_id:
        raise SystemExit("Pass --bootstrap-app-id or set WMPF_BOOTSTRAP_APP_ID")
    result = collect(args)
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
