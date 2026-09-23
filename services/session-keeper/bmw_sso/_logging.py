"""
Logging configuration helpers for the BMW SSO package.

A custom ``VERBOSE`` level (level 5) sits below ``DEBUG`` (10) and is used for
very detailed tracing — HTTP response bodies, full auth_bundle JSON, every form
field, etc.  It is disabled by default so normal ``DEBUG`` output stays readable.

Usage::

    import logging
    from bmw_sso import configure_file_logging

    # Optional: enable VERBOSE level to get the full trace in a file
    configure_file_logging("bmw_sso_debug.log", level=logging.DEBUG)  # or level=VERBOSE

    # Or in one line from outside:
    logging.getLogger("SSOSession").setLevel(bmw_sso.VERBOSE)
"""
import logging
import logging.handlers
import sys

# ---------------------------------------------------------------------------
# VERBOSE level — below DEBUG, disabled by default
# ---------------------------------------------------------------------------
VERBOSE = 5
logging.addLevelName(VERBOSE, "VERBOSE")


def verbose(self: logging.Logger, message: str, *args, **kwargs) -> None:
    """Emit a VERBOSE-level log record."""
    if self.isEnabledFor(VERBOSE):
        self._log(VERBOSE, message, args, **kwargs)  # noqa: SLF001


# Patch the level onto Logger instances so ``log.verbose(...)`` just works.
logging.Logger.verbose = verbose  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Public helper
# ---------------------------------------------------------------------------

def configure_file_logging(
    path: str = "bmw_sso.log",
    level: int = logging.DEBUG,
    *,
    also_to_stderr: bool = False,
    max_bytes: int = 5 * 1024 * 1024,
    backup_count: int = 2,
) -> logging.Logger:
    """
    Set up a rotating file handler on the ``SSOSession`` logger and return it.

    The file handler is set to *level* (default ``DEBUG``).  Pass
    ``level=VERBOSE`` to capture the very detailed trace including HTTP response
    bodies and full JSON auth_bundle dumps.

    :param path:           Path to the log file (created / appended to).
    :param level:          Minimum level written to the file (``logging.DEBUG``
                           or ``VERBOSE = 5``).
    :param also_to_stderr: If ``True``, also add a ``StreamHandler`` so the
                           same level is echoed to stderr in addition to the file.
    :param max_bytes:      Rotate the file when it reaches this size (default 5 MB).
    :param backup_count:   How many rotated files to keep (default 2).
    :return:               The configured ``SSOSession`` logger.
    """
    logger = logging.getLogger("SSOSession")
    logger.setLevel(min(logger.level if logger.level != logging.NOTSET else level, level))

    fmt = logging.Formatter(
        "%(asctime)s [%(name)s] %(levelname)-8s %(filename)s:%(lineno)d — %(message)s"
    )

    fh = logging.handlers.RotatingFileHandler(
        path, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
    )
    fh.setLevel(level)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    if also_to_stderr:
        sh = logging.StreamHandler(sys.stderr)
        sh.setLevel(level)
        sh.setFormatter(fmt)
        logger.addHandler(sh)

    return logger
