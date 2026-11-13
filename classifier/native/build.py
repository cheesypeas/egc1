#!/usr/bin/env python3
"""Rebuild the browser analysis module using Emscripten 4.0.10 (development only)."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--emscripten', type=Path, required=True, help='Directory containing emcc/em++')
args = parser.parse_args()
root = Path(__file__).resolve().parent
out = root.parent / 'vendor'
out.mkdir(exist_ok=True)
cc = args.emscripten / 'emcc'
cxx = args.emscripten / 'em++'
aubio = root / 'aubio' / 'src'
names = ['onset/onset.c', 'onset/peakpicker.c', 'pitch/pitch.c', 'pitch/pitchfcomb.c',
         'pitch/pitchmcomb.c', 'pitch/pitchschmitt.c', 'pitch/pitchspecacf.c', 'pitch/pitchyin.c',
         'pitch/pitchyinfast.c', 'pitch/pitchyinfft.c', 'spectral/awhitening.c', 'spectral/fft.c',
         'spectral/ooura_fft8g.c', 'spectral/phasevoc.c', 'spectral/specdesc.c', 'spectral/statistics.c',
         'temporal/biquad.c', 'temporal/c_weighting.c', 'temporal/filter.c', 'utils/hist.c', 'utils/log.c',
         'utils/scale.c', 'cvec.c', 'fvec.c', 'lvec.c', 'mathutils.c']
with tempfile.TemporaryDirectory(prefix='egc-wasm-build-') as temporary:
    objects = []
    for index, name in enumerate(names):
        obj = Path(temporary) / (str(index) + '.o')
        subprocess.run([str(cc), '-O3', '-DHAVE_CONFIG_H', '-I' + str(aubio), '-c', str(aubio / name), '-o', str(obj)], check=True)
        objects.append(str(obj))
    subprocess.run([str(cxx), '-O3', '-std=c++17', '-fexceptions',
        '-I' + str(root), '-I' + str(root / 'include'), '-I' + str(root / 'third_party/beat_this'),
        '-I' + str(root / 'third_party/beat_this/pocketfft'), '-I' + str(root / 'third_party/r8brain'),
        str(root / 'browser.cpp'), str(root / 'SampleAnalysis.cpp'), str(root / 'LoopBeatContext.cpp'),
        str(root / 'third_party/beat_this/MelSpectrogram.cpp'), str(root / 'third_party/beat_this/Postprocessor.cpp'),
        *objects, '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createAnalysis',
        '-sENVIRONMENT=web,worker', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432',
        '-sMAXIMUM_MEMORY=1073741824', '-sSTACK_SIZE=1048576',
        '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPF32"]',
        '-sEXPORTED_FUNCTIONS=["_malloc","_free","_toy_pitch","_toy_analyse","_toy_destroy","_toy_json",'
        '"_toy_beat_features","_toy_feature_data","_toy_apply_beats","_toy_resample","_toy_resampled_data"]',
        '-o', str(out / 'analysis.mjs')], check=True)
print(out / 'analysis.mjs')
