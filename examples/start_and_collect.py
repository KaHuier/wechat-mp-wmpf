from __future__ import annotations

import json
import os

import wechat_mp


def main() -> None:
    with wechat_mp.start_runtime(
        bootstrap_app_id=os.environ["WMPF_BOOTSTRAP_APP_ID"],
    ) as client:
        account = client.search_one("ACCOUNT_NAME")
        result = account.collect_all_articles()
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
