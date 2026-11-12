#include "SampleAnalysis.h"

#include <algorithm>
#include <array>
#include <cmath>


namespace {

double Wrap(double value, double length)
{
    value = std::fmod(value, length);
    return value < 0.0 ? value + length : value;
}

double Distance(double a, double b, double length)
{
    const double delta = std::abs(a - b);
    return std::min(delta, length - delta);
}

size_t BarReference(const SampleAnalysis & analysis)
{
    const auto nearest = std::min_element(analysis.beats.begin(), analysis.beats.end(), [&](int a, int b) {
        return Distance(a, analysis.barOrigin, analysis.numSamples) < Distance(b, analysis.barOrigin, analysis.numSamples);
    });
    return static_cast<size_t>(nearest - analysis.beats.begin());
}
}

void ResolveLoopBarReference(SampleAnalysis & analysis)
{
    analysis.beatPeriod = 0.0;
    analysis.barOrigin = 0.0;
    analysis.beatConfidence = 0.0f;
    if (analysis.numSamples <= 0 || analysis.sampleRate <= 0.0 || analysis.beats.size() < 4 ||
        analysis.beats.size() % 4 != 0 || analysis.downbeats.empty())
    {
        return;
    }
    const double bpm = 60.0 * analysis.sampleRate * analysis.beats.size() / analysis.numSamples;
    if (bpm < 30.0 || bpm > 400.0)
    {
        return;
    }
    std::array<int, 4> votes {};
    size_t first = 0;
    for (size_t i = 0; i < analysis.downbeats.size(); i++)
    {
        const int downbeat = analysis.downbeats[i];
        const auto nearest = std::min_element(analysis.beats.begin(), analysis.beats.end(), [&](int a, int b) {
            return Distance(a, downbeat, analysis.numSamples) < Distance(b, downbeat, analysis.numSamples);
        });
        const auto phase = static_cast<size_t>(nearest - analysis.beats.begin()) % 4;
        votes[phase]++;
        if (i == 0)
        {
            first = phase;
        }
    }
    const auto majority = std::max_element(votes.begin(), votes.end());
    size_t phase = static_cast<size_t>(majority - votes.begin());
    const double agreement = static_cast<double>(*majority) / analysis.downbeats.size();
    if (agreement < 0.6)
    {
        // A symmetric two-beat pattern can produce downbeats in both bar halves.
        // Use its first detected entry as a best-effort 4/4 grouping, with
        // reduced confidence. Other metres or unstable phases retain fallback.
        if (votes[(first + 1) % 4] != 0 || votes[(first + 3) % 4] != 0 || agreement < 0.4)
        {
            return;
        }
        phase = first;
    }
    analysis.beatPeriod = static_cast<double>(analysis.numSamples) / analysis.beats.size();
    analysis.barOrigin = std::fmod(analysis.beats[phase], 4.0 * analysis.beatPeriod);
    analysis.beatConfidence = static_cast<float>(agreement);
}

double LoopBarPosition(const SampleAnalysis & analysis, double barPhase)
{
    if (analysis.beats.empty() || analysis.numSamples <= 0)
    {
        return 0.0;
    }
    barPhase = Wrap(barPhase, analysis.beats.size());
    const size_t index = (BarReference(analysis) + static_cast<size_t>(barPhase)) % analysis.beats.size();
    const size_t following = (index + 1) % analysis.beats.size();
    const double began = analysis.beats[index];
    const double ended = analysis.beats[following] + (following == 0 ? analysis.numSamples : 0);
    return Wrap(began + (barPhase - std::floor(barPhase)) * (ended - began), analysis.numSamples);
}

bool HasReliableLoopGrid(const SampleAnalysis * analysis)
{
    return analysis != nullptr && analysis->numSamples >= 8 && analysis->eighths.size() >= 9 &&
        std::isfinite(analysis->beatPeriod) && analysis->beatPeriod > 0.0 &&
        analysis->beatConfidence >= 0.7f;
}

void BuildLoopGrid(SampleAnalysis & analysis)
{
    analysis.eighths.clear();
    if (analysis.numSamples < 8)
    {
        return;
    }
    ResolveLoopBarReference(analysis);
    const bool tracked = analysis.beatPeriod > 0.0;
    const int count = tracked ? static_cast<int>(analysis.beats.size() * 2) : 8;
    std::vector<double> positions;
    positions.reserve(static_cast<size_t>(count + 1));
    for (int i = 0; i < count; i++)
    {
        double point = tracked ? LoopBarPosition(analysis, i * 0.5) :
            static_cast<double>(i) * analysis.numSamples / count;
        if (!positions.empty())
        {
            while (point <= positions.back())
            {
                point += analysis.numSamples;
            }
        }
        positions.push_back(point);
    }
    positions.push_back(positions.front() + analysis.numSamples);
    for (int i = 0; i < count; i++)
    {
        const double previous = i == 0 ? positions[static_cast<size_t>(count - 1)] - analysis.numSamples : positions[static_cast<size_t>(i - 1)];
        const double point = positions[static_cast<size_t>(i)];
        const double next = positions[static_cast<size_t>(i + 1)];
        // Nearest precise attack, regardless of loudness. Disjoint search
        // windows retain ordering and never borrow an attack from another cell.
        const int radius = static_cast<int>(0.4 * std::min(point - previous, next - point));
        const int snapped = SnapLoopStart(&analysis, point, analysis.numSamples, radius);
        const double offset = snapped - Wrap(point, analysis.numSamples);
        analysis.eighths.push_back(static_cast<int>(std::llround(point + offset -
            std::round(offset / analysis.numSamples) * analysis.numSamples)));
    }
    const int shift = -static_cast<int>(std::floor(static_cast<double>(analysis.eighths.front()) /
                                                  analysis.numSamples)) * analysis.numSamples;
    for (auto & point : analysis.eighths)
    {
        point += shift;
    }
    analysis.eighths.push_back(analysis.eighths.front() + analysis.numSamples);
}
