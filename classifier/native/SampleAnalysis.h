#pragma once

#include <string>
#include <vector>

enum class SampleAnalysisKind { Pitch, Loop, Vocal };

// Version 2 recognises repeated ending fragments independently of bar length.
constexpr int kLoopBoundaryAnalysisVersion = 2;

struct SampleAnalysis
{
    double sampleRate = 48000.0;
    int numSamples = 0;
    bool hasRoot = false;
    float rootMidi = 60.0f;
    float pitchConfidence = 0.0f;
    std::vector<int> transients;
    std::vector<int> beats;
    std::vector<int> downbeats;
    std::string beatDetector;
    // Average source frames per quarter-note; origins refer to beat 1 of 4/4.
    // These describe the performed loop. They never move its source attacks.
    double beatPeriod = 0.0;
    double barOrigin = 0.0;
    float beatConfidence = 0.0f;
    // Ordered, unwrapped eighth-note boundaries from the first bar; final entry
    // closes the loop. Derived on the worker from beats and precise transients.
    std::vector<int> eighths;
    // Content onsets and up to eight phrase-prioritised defaults, in source order.
    // Vocal playback keeps its phrasing; these are independent of the beat grid.
    std::vector<int> vocalStarts;
    std::vector<int> vocalDefaults;
    // Static envelope triggers and perceptual strengths, normalised per sample.
    // Loops use transients; vocals use content starts rather than drum onsets.
    std::vector<int> gateStarts;
    std::vector<float> gateStrengths;
    // Independently versioned, worker-only end-fragment detection. PCM and raw
    // onset/beat coordinates retain the full file; only whole-loop playback uses
    // an accepted shorter end. Zero/missing version means an older cache.
    int loopBoundaryVersion = 0;
    int loopEndSample = 0;
    float loopEndConfidence = 0.0f;
    double loopPulseSamples = 0.0;
};

// Allocates and scans audio; call only on the analysis worker, never in playback.
// All analysis uses source channel zero, matching the sampler's left-only PCM.
SampleAnalysis AnalyseSample(const float * const * audio, int channels, int samples,
                            double sampleRate, SampleAnalysisKind kind, bool includeBeats = true);

// Nearest crossing at/before a cut, within 2 ms. Select the quieter of the two
// adjacent frames without moving past the attack or minimumPosition, or raising
// the boundary amplitude. If none exists, retain the cut. Never changes source
// PCM or the loop's frame count.
int FindCutZeroCrossing(const float * audio, int samples, int position, double sampleRate,
                        int minimumPosition = 0);

// Positions and distances are source sample frames. Search crosses the loop seam.
int SnapLoopStart(const SampleAnalysis * analysis, double position, int loopLength,
                  int maximumDistance);

// Eight positions per bar. Unknown metre falls back to one divided source loop.
int LoopBarCount(const SampleAnalysis * analysis);
int DefaultLoopStart(const SampleAnalysis * analysis, int key, int loopLength, int bar = 0);
void BuildLoopGrid(SampleAnalysis & analysis);
void ResolveLoopBarReference(SampleAnalysis & analysis);
double LoopBarPosition(const SampleAnalysis & analysis, double beatPosition);
// Fallback slice positions are playable keys, not evidence of musical timing.
bool HasReliableLoopGrid(const SampleAnalysis * analysis);
void BuildLoopBoundaryAnalysis(SampleAnalysis & analysis, const float * const * audio, int channels);
int LoopPlaybackEnd(const SampleAnalysis * analysis, int sourceSamples);

// Worker-only content analysis; retains existing tempo evidence for loop retiming.
void BuildVocalCuts(SampleAnalysis & analysis, const float * const * audio, int channels);
void BuildGateAnalysis(SampleAnalysis & analysis, const float * const * audio, int channels,
                       SampleAnalysisKind kind);
int DefaultVocalStart(const SampleAnalysis * analysis, int key, int length, int alternative = 0);
