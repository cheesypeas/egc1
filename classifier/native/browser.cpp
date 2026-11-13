// Browser adapter around the unmodified ToySampler analysis implementation.
// Inference is performed by ONNX Runtime Web; preparation/postprocessing stays C++.
#include "SampleAnalysis.h"
#include "BeatAnalysis.h"
#include "MelSpectrogram.h"
#include "Postprocessor.h"
#include "CDSPResampler.h"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <locale>
#include <sstream>
#include <vector>

std::string LoopBeatDetectorIdentity() { return "browser-beat-this-final0-c5c1466e08abdb03-v1"; }
void AnalyseLoopBeats(SampleAnalysis &, const float * const *, int) {}

namespace {
void Normalise(float * audio, int samples)
{
    float peak = 0.0f;
    for (int i = 0; i < samples; i++) { peak = std::max(peak, std::abs(audio[i])); }
    if (peak > 0.0f)
    {
        for (int i = 0; i < samples; i++) { audio[i] *= 1.0f / peak; }
    }
}
struct Prepared
{
    float * left;
    int channels; // Original file layout; processing retains only left.
    int samples;
    double rate;
    int cycles = 0;
    SampleAnalysis pitch;
    SampleAnalysis loop;
    std::vector<float> features;
    std::vector<float> resampled;
    std::string json;
    const float * pointers[2];
    Prepared(float * a, int count, int frames, double sr) :
        left(a), channels(count), samples(frames), rate(sr), pointers {a, nullptr}
    {
        Normalise(left, samples);
        pitch = AnalyseSample(pointers, 1, samples, rate, SampleAnalysisKind::Pitch, false);
        loop = AnalyseSample(pointers, 1, samples, rate, SampleAnalysisKind::Loop, false);
    }
};

template<class T>
void Array(std::ostream & out, const std::vector<T> & values)
{
    out << '[';
    for (size_t i = 0; i < values.size(); i++)
    {
        if (i) { out << ','; }
        out << values[i];
    }
    out << ']';
}

void AnalysisJson(std::ostream & out, const SampleAnalysis & value, SampleAnalysisKind kind)
{
    out << "{\"version\":1,\"analysisVersion\":" << (kind == SampleAnalysisKind::Pitch ? 5 : kind == SampleAnalysisKind::Vocal ? 2 : 8)
        << ",\"analysisRole\":\"" << (kind == SampleAnalysisKind::Pitch ? "pitch" : kind == SampleAnalysisKind::Vocal ? "vocal" : "loop")
        << "\",\"analysisImplementation\":\"" << (kind == SampleAnalysisKind::Pitch ? "toysampler-wasm-v3-rate-aware-pitch" : "toysampler-wasm-v2-left-zero-crossings") << "\",\"rate\":" << value.sampleRate
        << ",\"samples\":" << value.numSamples << ",\"hasRoot\":" << (value.hasRoot ? "true" : "false")
        << ",\"root\":" << value.rootMidi << ",\"confidence\":" << value.pitchConfidence << ",\"transients\":";
    Array(out, value.transients);
    out << ",\"beats\":"; Array(out, value.beats);
    out << ",\"downbeats\":"; Array(out, value.downbeats);
    out << ",\"beatDetector\":\"" << value.beatDetector << "\",\"beatPeriod\":" << value.beatPeriod
        << ",\"barOrigin\":" << value.barOrigin << ",\"beatConfidence\":" << value.beatConfidence
        << ",\"eighths\":"; Array(out, value.eighths);
    out << ",\"vocalStarts\":"; Array(out, value.vocalStarts);
    out << ",\"vocalDefaults\":"; Array(out, value.vocalDefaults);
    out << ",\"gateVersion\":1,\"gateStarts\":"; Array(out, value.gateStarts);
    out << ",\"gateStrengths\":"; Array(out, value.gateStrengths);
    if (kind == SampleAnalysisKind::Loop)
    {
        out << ",\"loopBoundaryVersion\":" << value.loopBoundaryVersion << ",\"loopEndSample\":" << value.loopEndSample
            << ",\"loopEndConfidence\":" << value.loopEndConfidence << ",\"loopPulseSamples\":" << value.loopPulseSamples;
    }
    out << '}';
}

std::vector<float> Resample(const float * input, int count, double from, double to, int cycles = 1)
{
    const long long total = static_cast<long long>(count) * cycles;
    const size_t target = static_cast<size_t>(std::ceil(total * to / from));
    std::vector<float> result;
    result.reserve(target + 4096);
    r8b::CDSPResampler24 resampler(from, to, 4096);
    std::vector<double> block(4096);
    for (long long at = 0; result.size() < target; at += 4096)
    {
        for (int i = 0; i < 4096; i++) { block[i] = at + i < total ? input[(at + i) % count] : 0.0; }
        double * output = nullptr;
        const int n = resampler.process(block.data(), 4096, output);
        for (int i = 0; i < n; i++) { result.push_back(static_cast<float>(output[i])); }
    }
    result.resize(target);
    return result;
}
std::vector<float> converted;
}

extern "C" {
const char * toy_pitch(float * left, int channels, int samples, double rate, double embeddedRoot)
{
    if (channels < 1 || channels > 2 || samples <= 0 || samples >= rate * 60 || rate < 8000 || rate > 192000) { return nullptr; }
    Normalise(left, samples);
    const float * audio[] {left};
    const auto acoustic = AnalyseSample(audio, 1, samples, rate, SampleAnalysisKind::Pitch, false);
    auto playback = acoustic;
    if (embeddedRoot >= 0.0 && embeddedRoot <= 127.0)
    {
        playback.hasRoot = true;
        playback.rootMidi = static_cast<float>(embeddedRoot);
        playback.pitchConfidence = 1.0f;
    }
    std::ostringstream out;
    out.imbue(std::locale::classic());
    // Portable pitch schema v5 remains readable by the deployed instrument.
    // The implementation identity versions the rate-aware estimator separately.
    out << std::setprecision(12) << "{\"pitch\":";
    AnalysisJson(out, playback, SampleAnalysisKind::Pitch);
    out << ",\"acousticPitch\":";
    AnalysisJson(out, acoustic, SampleAnalysisKind::Pitch);
    out << '}';
    static std::string json;
    json = out.str();
    return json.c_str();
}
Prepared * toy_analyse(float * left, float *, int channels, int samples, double rate)
{
    if (channels < 1 || channels > 2 || samples <= 0 || samples >= rate * 60 || rate < 8000 || rate > 192000) { return nullptr; }
    return new Prepared(left, channels, samples, rate);
}
void toy_destroy(Prepared * value) { delete value; }

const char * toy_json(Prepared * value, double embeddedRoot)
{
    auto vocal = value->loop;
    BuildVocalCuts(vocal, value->pointers, 1);
    BuildGateAnalysis(vocal, value->pointers, 1, SampleAnalysisKind::Vocal);
    auto playbackPitch = value->pitch;
    if (embeddedRoot >= 0.0 && embeddedRoot <= 127.0)
    {
        playbackPitch.hasRoot = true;
        playbackPitch.rootMidi = static_cast<float>(embeddedRoot);
        playbackPitch.pitchConfidence = 1.0f;
    }
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setprecision(12) << "{\"version\":1,\"channels\":" << value->channels << ",\"pitch\":";
    AnalysisJson(out, playbackPitch, SampleAnalysisKind::Pitch);
    out << ",\"acousticPitch\":"; AnalysisJson(out, value->pitch, SampleAnalysisKind::Pitch);
    out << ",\"loop\":"; AnalysisJson(out, value->loop, SampleAnalysisKind::Loop);
    out << ",\"vocal\":"; AnalysisJson(out, vocal, SampleAnalysisKind::Vocal);
    out << '}';
    value->json = out.str();
    return value->json.c_str();
}

int toy_beat_features(Prepared * value)
{
    if (value->samples / value->rate < .15 || value->loop.transients.size() < 4) { return 0; }
    value->cycles = std::max(3, static_cast<int>(std::ceil(8.0 / (value->samples / value->rate))) + 2);
    auto audio = Resample(value->left, value->samples, value->rate, 22050.0, value->cycles);
    MelSpectrogram frontend;
    const auto features = frontend.compute(audio);
    value->features.clear();
    value->features.reserve(features.size() * 128);
    for (const auto & frame : features) { value->features.insert(value->features.end(), frame.begin(), frame.end()); }
    return static_cast<int>(features.size());
}
const float * toy_feature_data(Prepared * value) { return value->features.data(); }

void toy_apply_beats(Prepared * value, const float * beat, const float * downbeat, int frames)
{
    std::vector<float> beats(beat, beat + frames), downbeats(downbeat, downbeat + frames);
    Postprocessor decoder;
    const auto predictions = decoder.process(beats, downbeats);
    const double seconds = value->samples / value->rate;
    const double began = (value->cycles / 2) * seconds;
    auto & result = value->loop;
    result.beats.clear(); result.downbeats.clear();
    result.beatDetector = LoopBeatDetectorIdentity();
    for (int kind = 0; kind < 2; kind++)
    {
        const auto & times = kind ? predictions.second : predictions.first;
        auto & target = kind ? result.downbeats : result.beats;
        for (float time : times)
        {
            if (time < began - .04 || time >= began + seconds - .04) { continue; }
            const double position = std::fmod((time - began) * value->rate + value->samples, value->samples);
            target.push_back(std::min(value->samples - 1, static_cast<int>(std::llround(position))));
        }
        std::sort(target.begin(), target.end());
        target.erase(std::unique(target.begin(), target.end()), target.end());
    }
    BuildLoopGrid(result);
    BuildLoopBoundaryAnalysis(result, value->pointers, 1);
}

int toy_resample(const float * source, int count, double from, double to)
{
    converted = Resample(source, count, from, to);
    return static_cast<int>(converted.size());
}
const float * toy_resampled_data() { return converted.data(); }
}
