"""무거운 작업은 한 번에 하나만.

큰 사진의 누끼(단색 배경 에셋 · 아이템), 폴더 작업의 한 장(누끼 + 합성 + 저장 형식 변환), 이미지 디코딩은 각각
수백 MB~1GB 를 잠깐 쓴다. 편집기 누끼와 폴더 작업이 동시에 돌면 그 순간 사용량이 겹쳐, 메모리 여유가 적은 PC
(Unity 등을 켜 둔 상태)에서는 다른 프로그램까지 메모리 부족을 겪는다. 그래서 이 자물쇠 하나로 줄을 세운다.

app.py 와 batch.py 가 같이 쓰므로 (서로 import 하면 순환이 생겨) 따로 둔다.
"""

from __future__ import annotations

import threading
from typing import Callable

HEAVY = threading.BoundedSemaphore(1)
WAIT_MSG = "다른 작업이 끝나길 기다리는 중"


def acquire(on_wait: Callable[[], None] | None = None, cancelled: Callable[[], bool] | None = None,
            poll: float = 0.25) -> bool:
    """HEAVY 를 잡는다. 바로 못 잡으면 on_wait() 를 한 번 부르고 기다린다.

    cancelled() 가 참이 되면 기다리기를 그만두고 False (자물쇠는 잡지 않은 상태). 잡았으면 True —
    끝나면 반드시 HEAVY.release() 를 불러야 한다.
    """
    if HEAVY.acquire(blocking=False):
        return True
    if on_wait is not None:
        on_wait()
    while True:
        if cancelled is not None and cancelled():
            return False
        if HEAVY.acquire(timeout=poll):
            return True
