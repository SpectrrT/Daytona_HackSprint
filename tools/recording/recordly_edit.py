#!/usr/bin/env python3
"""Cut actual terminal footage, remap its measured pointer samples, and export
through the official Recordly application. No captions or replacement UI.

Segments JSON: [{"start": 0, "end": 12, "speed": 1, "focus": [0.5, 0.4]}]
Times are seconds in the original capture; focus is an optional source position.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def probe(path):
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("segments", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recordly", type=Path)
    args = parser.parse_args()
    video, directory = args.video.resolve(), args.output.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "clips").mkdir(exist_ok=True)
    metadata = probe(video)
    stream = next(value for value in metadata["streams"] if value["codec_type"] == "video")
    width, height, duration = stream["width"], stream["height"], float(metadata["format"]["duration"])
    segments = json.loads(args.segments.read_text())
    assert segments and isinstance(segments, list)
    samples = json.loads(Path(str(video) + ".cursor.json").read_text())["samples"]
    scale = min(1920 / width, 1080 / height)
    scaled_width, scaled_height = round(width * scale / 2) * 2, round(height * scale / 2) * 2
    pad_x, pad_y = (1920 - scaled_width) / 2, (1080 - scaled_height) / 2
    output_samples, zooms, manifest, clips, offset = [], [], [], [], 0.0

    def transform(sample, time_ms):
        return {**sample, "timeMs": time_ms, "cx": (sample["cx"] * scaled_width + pad_x) / 1920, "cy": (sample["cy"] * scaled_height + pad_y) / 1080}

    for index, segment in enumerate(segments):
        start, end, speed = float(segment["start"]), float(segment["end"]), float(segment.get("speed", 1))
        assert 0 <= start < end <= duration + 0.05 and 0.25 <= speed <= 30
        length = (end - start) / speed
        clip = directory / "clips" / f"clip-{index:02d}.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(start), "-t", str(end - start), "-i", str(video), "-an", "-vf", f"setpts=(PTS-STARTPTS)/{speed},scale={scaled_width}:{scaled_height},pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x111318,fps=30", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", str(clip)], check=True)
        clips.append(clip)
        in_clip = [sample for sample in samples if start * 1000 <= sample["timeMs"] < end * 1000]
        if in_clip:
            output_samples.append(transform({**in_clip[0], "interactionType": "move"}, offset * 1000))
            output_samples.extend(transform(sample, offset * 1000 + (sample["timeMs"] - start * 1000) / speed) for sample in in_clip)
            output_samples.append(transform({**in_clip[-1], "interactionType": "move"}, (offset + length) * 1000 - 1))
        if segment.get("focus") and length >= 4:
            focus = segment["focus"]
            zooms.append({"id": f"focus-{index}", "startMs": round((offset + 0.5) * 1000), "endMs": round((offset + length - 0.5) * 1000), "depth": 1, "focus": {"cx": max(0.28, min(0.72, (focus[0] * scaled_width + pad_x) / 1920)), "cy": max(0.28, min(0.72, (focus[1] * scaled_height + pad_y) / 1080))}, "mode": "manual"})
        manifest.append({"source_start_seconds": start, "source_end_seconds": end, "speed": speed, "output_start_seconds": offset, "output_end_seconds": offset + length})
        offset += length
    source = directory / "actual-claude-terminal-source.mp4"
    concat = directory / "clips.txt"
    concat.write_text("".join("file '" + str(clip).replace("'", "'\\''") + "'\n" for clip in clips))
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(source)], check=True)
    Path(str(source) + ".cursor.json").write_text(json.dumps({"version": 1, "samples": output_samples}))
    project = directory / "claude-terminal.recordly"
    project.write_text(json.dumps({"version": 2, "videoPath": str(source), "editor": {
        "wallpaper": "#111318", "showCursor": True, "loopCursor": False, "cursorSize": 2.2,
        "cursorSmoothing": 0.85, "cursorMotionBlur": 0.08, "cursorClickBounce": 0.3,
        "borderRadius": 6, "padding": {"top": 5, "bottom": 5, "left": 5, "right": 5, "linked": True},
        "shadowIntensity": 0.15, "backgroundBlur": 0, "zoomMotionBlur": 0.06,
        "connectZooms": False, "aspectRatio": "16:9", "zoomRegions": zooms,
        "annotationRegions": [], "trimRegions": [], "clipRegions": [], "speedRegions": [],
        "autoCaptions": [], "autoCaptionSettings": {"enabled": False},
    }}, indent=2))
    (directory / "edit-manifest.json").write_text(json.dumps({"source": str(video), "source_sha256": hashlib.sha256(video.read_bytes()).hexdigest(), "actual_terminal_footage": True, "cursor_source": "Measured X11 pointer position and button samples, transformed with the identical cuts", "captions": False, "segments": manifest}, indent=2))
    if args.recordly:
        output = directory / "antibody-claude-terminal.mp4"
        environment = {key: os.environ[key] for key in ["PATH", "HOME", "TMPDIR"] if key in os.environ}
        environment.update({"LANG": "en_US.UTF-8", "RECORDLY_SMOKE_EXPORT": "1", "RECORDLY_SMOKE_EXPORT_PROJECT": str(project), "RECORDLY_SMOKE_EXPORT_OUTPUT": str(output), "RECORDLY_SMOKE_EXPORT_QUALITY": "source", "RECORDLY_SMOKE_EXPORT_FPS": "30"})
        with (directory / "recordly-export.log").open("w") as log:
            subprocess.run([str(args.recordly.resolve())], env=environment, stdout=log, stderr=log, timeout=240, check=True)
        report = json.loads(Path(str(output) + ".report.json").read_text())
        assert report["success"] is True, "Recordly did not report a successful export"
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(output), "-f", "null", "-"], check=True)
        final_project = json.loads(project.read_text())
        assert not final_project["editor"]["autoCaptions"] and not final_project["editor"]["autoCaptionSettings"]["enabled"]
        (directory / "video-verification.json").write_text(json.dumps({"probe": probe(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "full_decode_passed": True, "recordly_export_succeeded": True, "captions": 0, "cursor_samples": len(output_samples), "cursor_size": 2.2, "cursor_smoothing": 0.85, "camera_focus_regions": len(zooms)}, indent=2))
        print(output)
    else:
        print(project)


if __name__ == "__main__":
    main()
