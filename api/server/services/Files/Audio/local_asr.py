import base64
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path


def _extension_for_mime(mime_type: str) -> str:
    lowered = (mime_type or "").lower()
    if "wav" in lowered:
        return ".wav"
    if "mpeg" in lowered or "mp3" in lowered:
        return ".mp3"
    if "ogg" in lowered:
        return ".ogg"
    guessed = mimetypes.guess_extension(lowered.split(";")[0].strip())
    return guessed or ".webm"


def _clean_text(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    text = re.sub(r"<\|[^|]+\|>", "", text)
    return text.strip()


def _extract_text(result) -> str:
    if isinstance(result, list) and result:
        return _extract_text(result[0])
    if isinstance(result, dict):
        for key in ("text", "sentence", "value"):
            text = _clean_text(result.get(key))
            if text:
                return text
    return _clean_text(result)


def _resolve_device(requested: str) -> str:
    requested = (requested or "").strip() or "cuda:0"
    if requested.startswith("cuda"):
        try:
            import torch

            if not torch.cuda.is_available():
                return "cpu"
        except Exception:
            return "cpu"
    return requested


def _convert_to_wav(input_path: Path, output_path: Path) -> None:
    command = [
        os.getenv("DUPSEARCH_LOCAL_ASR_FFMPEG", "ffmpeg"),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(output_path),
    ]
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _load_model(model_path: str, device: str):
    from funasr import AutoModel

    try:
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
    except Exception:
        rich_transcription_postprocess = None

    model = AutoModel(model=model_path, trust_remote_code=False, device=device, disable_update=True)
    return model, rich_transcription_postprocess


def _transcribe_with_model(wav_path: Path, model, rich_transcription_postprocess) -> str:
    result = model.generate(
        input=str(wav_path),
        cache={},
        language="auto",
        use_itn=True,
        batch_size_s=60,
    )
    text = _extract_text(result)
    if rich_transcription_postprocess is not None:
        text = rich_transcription_postprocess(text)
    return _clean_text(text)


def _transcribe(wav_path: Path, model_path: str, device: str) -> str:
    model, rich_transcription_postprocess = _load_model(model_path, device)
    return _transcribe_with_model(wav_path, model, rich_transcription_postprocess)


def _prepare_wav(payload: dict, tmpdir: str) -> Path:
    audio_base64 = str(payload.get("audio") or "").strip()
    if not audio_base64:
        raise ValueError("audio is required")

    audio_bytes = base64.b64decode(audio_base64)
    extension = _extension_for_mime(str(payload.get("mime") or "audio/webm"))
    input_path = Path(tmpdir) / f"recording{extension}"
    wav_path = Path(tmpdir) / "recording.wav"
    input_path.write_bytes(audio_bytes)
    _convert_to_wav(input_path, wav_path)
    return wav_path


def _transcribe_payload(payload: dict, model_cache: dict | None = None) -> str:
    model_path = str(payload.get("model") or os.getenv("DUPSEARCH_LOCAL_ASR_MODEL") or "iic/SenseVoiceSmall")
    device = _resolve_device(str(payload.get("device") or os.getenv("DUPSEARCH_LOCAL_ASR_DEVICE") or "cuda:0"))
    cache_key = (model_path, device)

    with tempfile.TemporaryDirectory(prefix="vizion-local-asr-") as tmpdir:
        wav_path = _prepare_wav(payload, tmpdir)
        if model_cache is None:
            return _transcribe(wav_path, model_path, device)

        if cache_key not in model_cache:
            model_cache[cache_key] = _load_model(model_path, device)
        model, rich_transcription_postprocess = model_cache[cache_key]
        return _transcribe_with_model(wav_path, model, rich_transcription_postprocess)


def serve() -> int:
    model_cache = {}
    for raw_line in sys.stdin:
      raw_line = raw_line.strip()
      if not raw_line:
          continue
      request_id = None
      try:
          payload = json.loads(raw_line)
          request_id = payload.get("id")
          with redirect_stdout(sys.stderr):
              text = _transcribe_payload(payload, model_cache=model_cache)
          print(json.dumps({"id": request_id, "text": text}, ensure_ascii=True), flush=True)
      except Exception as exc:
          print(json.dumps({"id": request_id, "error": str(exc)}, ensure_ascii=True), flush=True)
    return 0


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    with redirect_stdout(sys.stderr):
        text = _transcribe_payload(payload)

    print(json.dumps({"text": text}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        if "--server" in sys.argv:
            raise SystemExit(serve())
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
