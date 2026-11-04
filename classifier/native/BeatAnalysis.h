#pragma once

#include <string>

struct SampleAnalysis;

// Worker-only neural beat/downbeat tracking. An unavailable model leaves an empty map.
void AnalyseLoopBeats(SampleAnalysis & result, const float * const * audio, int channels);
std::string LoopBeatDetectorIdentity();
