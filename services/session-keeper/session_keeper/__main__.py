"""Allow running with ``python -m session_keeper``."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "session_keeper.app:app",
        host="0.0.0.0",
        port=8090,
        log_level="info",
    )
