from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterator


@dataclass(frozen=True, slots=True)
class OfficialAccountInfo:
    name: str
    user_name: str = ""
    alias: str = ""
    bizuin: str = ""
    signature: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> OfficialAccountInfo:
        return cls(
            name=str(value.get("name") or ""),
            user_name=str(value.get("user_name") or ""),
            alias=str(value.get("alias") or ""),
            bizuin=str(value.get("bizuin") or ""),
            signature=str(value.get("signature") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ProfileTarget:
    target_id: str
    url: str
    account: OfficialAccountInfo

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_id": self.target_id,
            "url": self.url,
            "account": self.account.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class Article:
    account_name: str
    account_id: str
    msg_id: int | None
    item_index: int
    title: str
    digest: str
    url: str
    cover_url: str
    publish_time: int | None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Article:
        msg_id = value.get("msg_id")
        publish_time = value.get("publish_time")
        return cls(
            account_name=str(value.get("account_name") or ""),
            account_id=str(value.get("account_id") or ""),
            msg_id=int(msg_id) if msg_id is not None else None,
            item_index=int(value.get("item_index") or 1),
            title=str(value.get("title") or ""),
            digest=str(value.get("digest") or ""),
            url=str(value.get("url") or ""),
            cover_url=str(value.get("cover_url") or ""),
            publish_time=int(publish_time) if publish_time is not None else None,
        )

    @property
    def key(self) -> str:
        if self.url:
            return self.url
        return f"{self.msg_id or ''}:{self.item_index}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ArticlePage:
    number: int
    articles: tuple[Article, ...]
    offset: str | int | None
    is_end: bool

    def __iter__(self) -> Iterator[Article]:
        return iter(self.articles)

    def to_dict(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "articles": [article.to_dict() for article in self.articles],
            "offset": self.offset,
            "is_end": self.is_end,
        }


@dataclass(frozen=True, slots=True)
class ArticleCollection:
    account: OfficialAccountInfo
    articles: tuple[Article, ...]
    pages_loaded: int
    is_end: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "account": self.account.to_dict(),
            "articles": [article.to_dict() for article in self.articles],
            "pages_loaded": self.pages_loaded,
            "is_end": self.is_end,
        }
