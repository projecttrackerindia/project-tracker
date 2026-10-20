"""Transcribes a call recording with faster-whisper. Usage: transcribe.py <file> <model> [language]. Prints {"segments":[{start,end,text}]}."""
import json
import os
import sys

from faster_whisper import WhisperModel


def main():
    path, model = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    threads = int(os.environ.get("MEETBOT_WHISPER_THREADS", "2"))
    whisper = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, _info = whisper.transcribe(path, language=language, vad_filter=True, beam_size=1,
                                         condition_on_previous_text=False)
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments if s.text.strip()]
    json.dump({"segments": out}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
