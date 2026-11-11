#include "SampleAnalysis.h"
#include "BeatAnalysis.h"

#include <aubio/aubio.h>
#include <algorithm>
#include <cmath>
#include <memory>

namespace {

using Vector = std::unique_ptr<fvec_t, decltype(&del_fvec)>;
using Pitch = std::unique_ptr<aubio_pitch_t, decltype(&del_aubio_pitch)>;
using Onset = std::unique_ptr<aubio_onset_t, decltype(&del_aubio_onset)>;

int RefineAttack(const float * const * audio, int channels, int samples,
                 int candidate, double sampleRate, double searchSeconds)
{
    const int width = std::max(1, static_cast<int>(sampleRate * 0.00025));
    const int radius = static_cast<int>(sampleRate * searchSeconds);
    const int leadingRadius = std::max(radius, static_cast<int>(sampleRate * (searchSeconds < 0.01 ? 0.012 : 0.05)));
    const int begin = std::max(0, candidate - leadingRadius);
    const int end = std::min(samples, candidate + radius + 1);
    std::vector<double> power(static_cast<size_t>(end - begin + 1), 0.0);
    for (int at = begin; at < end; at++)
    {
        double energy = 0.0;
        for (int channel = 0; channel < channels; channel++)
        {
            energy += audio[channel][at] * audio[channel][at];
        }
        power[static_cast<size_t>(at - begin + 1)] = power[static_cast<size_t>(at - begin)] + energy;
    }
    const auto envelope = [&](int at) {
        const int right = std::max(0, std::min(end - begin, at - begin + 1));
        const int left = std::max(0, right - width);
        return (power[static_cast<size_t>(right)] - power[static_cast<size_t>(left)]) / width;
    };
    double bestRise = 0.0;
    int best = candidate;
    for (int at = std::max(begin, candidate - radius); at < end; at++)
    {
        const double rise = envelope(at) - envelope(at - width);
        // Rank the local relative rise, so a nearby quiet leading edge is not
        // pulled onto a louder neighbour elsewhere in the search window.
        const double score = rise / std::max(1.0e-12, envelope(at)) /
            (1.0 + std::abs(at - candidate) / (sampleRate * 0.003));
        if (score > bestRise)
        {
            bestRise = score;
            best = at;
        }
    }
    const int earliest = std::max(begin, best - leadingRadius);
    std::vector<double> floor;
    for (int at = earliest; at < best - width; at++)
    {
        floor.push_back(envelope(at));
    }
    // A slower drum attack may already be rising 4 ms before its strongest
    // slope. Estimate the quiet floor across the earlier neighbourhood instead
    // of mistaking the body of that same hit for background noise.
    double baseline = 0.0;
    if (!floor.empty())
    {
        const auto percentile = floor.size() / 5;
        std::nth_element(floor.begin(), floor.begin() + static_cast<long>(percentile), floor.end());
        baseline = floor[percentile];
    }
    // A snare can have a quiet stick/noise lead before its main body. A 2%
    // peak-power threshold discarded that lead; use the local noise floor and
    // a much smaller relative threshold when walking back to the true start.
    const double threshold = baseline + std::max(2.0 * baseline,
        0.0001 * std::max(0.0, envelope(best) - baseline));
    int foot = best;
    while (foot > earliest && envelope(foot - 1) > threshold)
    {
        foot--;
    }
    // Keep one source sample before the detected leading edge, without frame
    // rounding. Crossing refinement follows detection and contrast checks.
    return std::max(0, foot - 1);
}

bool HasAttackContrast(const float * const * audio, int channels, int samples,
                       int position, double sampleRate, double seconds, double minimumRatio)
{
    if (position == 0)
    {
        return true;
    }
    const int width = std::max(1, static_cast<int>(sampleRate * seconds));
    const int before = std::min(width, position);
    const int after = std::min(width, samples - position);
    double previous = 0.0;
    double following = 0.0;
    for (int channel = 0; channel < channels; channel++)
    {
        for (int i = position - before; i < position; i++)
        {
            previous += audio[channel][i] * audio[channel][i];
        }
        for (int i = position; i < position + after; i++)
        {
            following += audio[channel][i] * audio[channel][i];
        }
    }
    // Spectral fluctuations in a sustained/noisy tail are not fresh drum hits.
    // Compare local energy, not a fraction of the whole file's loudest hit, so
    // a quiet flam can still pass after its louder neighbour has decayed.
    // Check audibility at the refined hit, rather than the delayed FFT output:
    // a short quiet hit may already have decayed when aubio reports its peak.
    const double followingPower = following / after;
    return followingPower > 3.162277660168379e-6 && // -55 dBFS mean power.
        followingPower > minimumRatio * std::max(1.0e-12, previous / before);
}

bool HasFastAttackContent(const float * const * audio, int channels, int samples,
                          int position, double sampleRate)
{
    double energy = 0.0;
    double differenceEnergy = 0.0;
    const int end = std::min(samples, position + static_cast<int>(sampleRate * 0.002));
    for (int channel = 0; channel < channels; channel++)
    {
        for (int i = std::max(1, position); i < end; i++)
        {
            const double value = audio[channel][i];
            const double difference = value - audio[channel][i - 1];
            energy += value * value;
            differenceEnergy += difference * difference;
        }
    }
    // The short FFT resolves fast/noisy attacks, not individual cycles of a
    // low bass drum's body. Let the long-window detector locate its full lead.
    const double limit = 2.0 * std::sin(3.141592653589793 * 200.0 / sampleRate);
    return differenceEnergy > limit * limit * std::max(1.0e-12, energy);
}

void FindTransients(SampleAnalysis & result, const float * const * audio, int channels)
{
    constexpr int hop = 32;
    Vector input(new_fvec(hop), del_fvec);
    Vector output(new_fvec(1), del_fvec);
    if (!input || !output)
    {
        return;
    }
    // Analyse the audible left channel; right-channel events must not create cuts.
    for (int channel = 0; channel < channels; channel++)
    {
        // The short window resolves quiet flams hidden under a loud hit in the
        // longer FFT window. Keep the long window for low-frequency/softer attacks.
        for (int window : {1024, 256})
        {
            Onset detector(new_aubio_onset("specflux", static_cast<uint_t>(window), hop,
                                          static_cast<uint_t>(result.sampleRate)), del_aubio_onset);
            if (!detector)
            {
                return;
            }
            // Leave headroom for quiet decaying hits; HasAttackContrast applies
            // the -55 dBFS audibility check to the actual refined attack.
            aubio_onset_set_silence(detector.get(), -80.0f);
            aubio_onset_set_minioi_ms(detector.get(), 6.0f);
            // Small hops make the stock peak picker much more sensitive to
            // texture, especially with the short window. These thresholds are
            // checked against real breaks as well as isolated synthetic hits.
            aubio_onset_set_threshold(detector.get(), window == 256 ? 1.0f : 0.3f);
            for (int offset = 0; offset < result.numSamples + window; offset += hop)
            {
                for (int i = 0; i < hop; i++)
                {
                    input->data[i] = offset + i < result.numSamples ? audio[channel][offset + i] : 0.0f;
                }
                aubio_onset_do(detector.get(), input.get(), output.get());
                if (output->data[0] > 0.0f)
                {
                    const auto detected = aubio_onset_get_last(detector.get());
                    if (detected < static_cast<uint_t>(result.numSamples))
                    {
                        const int position = RefineAttack(audio, channels, result.numSamples,
                                                          static_cast<int>(detected), result.sampleRate,
                                                          window == 256 ? 0.004 : 0.020);
                        if ((window != 256 || HasFastAttackContent(audio, channels, result.numSamples, position, result.sampleRate)) &&
                            HasAttackContrast(audio, channels, result.numSamples, position,
                                              result.sampleRate, window == 256 ? 0.002 : 0.010,
                                              window == 256 ? 1.8 : 1.5))
                        {
                            result.transients.push_back(position);
                        }
                    }
                }
            }
        }
    }
    std::sort(result.transients.begin(), result.transients.end());
    const int minimumGap = std::max(1, static_cast<int>(result.sampleRate * 0.006));
    auto end = std::unique(result.transients.begin(), result.transients.end(),
                          [minimumGap](int a, int b) { return b - a < minimumGap; });
    result.transients.erase(end, result.transients.end());
    int minimum = 0;
    for (auto & position : result.transients)
    {
        const int attack = position;
        position = FindCutZeroCrossing(audio[0], result.numSamples, position, result.sampleRate, minimum);
        minimum = attack + 1; // Never borrow a crossing from the preceding hit.
    }
}

void FindPitch(SampleAnalysis & result, const float * const * audio, int channels)
{
    int window = 4096;
    while (window > result.numSamples)
    {
        window /= 2;
    }
    if (window < 512)
    {
        return;
    }
    Vector input(new_fvec(static_cast<uint_t>(window)), del_fvec);
    Vector output(new_fvec(1), del_fvec);
    Pitch detector(new_aubio_pitch("yinfast", static_cast<uint_t>(window), static_cast<uint_t>(window),
                                  static_cast<uint_t>(result.sampleRate)), del_aubio_pitch);
    if (!input || !output || !detector)
    {
        return;
    }
    aubio_pitch_set_unit(detector.get(), "midi");
    aubio_pitch_set_silence(detector.get(), -55.0f);
    aubio_pitch_set_tolerance(detector.get(), 0.15f);
    const int first = std::min(result.numSamples - window, static_cast<int>(result.sampleRate * 0.025));
    const int available = result.numSamples - window - first;
    const int frames = std::min(12, 1 + available / 256);
    std::vector<float> pitches;
    float confidenceSum = 0.0f;
    int audibleFrames = 0;
    for (int frame = 0; frame < frames; frame++)
    {
        const int offset = first + (frames > 1 ? static_cast<int>(static_cast<long long>(available) * frame / (frames - 1)) : 0);
        int bestChannel = 0;
        double bestEnergy = 0.0;
        for (int channel = 0; channel < channels; channel++)
        {
            double energy = 0.0;
            for (int i = 0; i < window; i++)
            {
                energy += audio[channel][offset + i] * audio[channel][offset + i];
            }
            if (energy > bestEnergy)
            {
                bestEnergy = energy;
                bestChannel = channel;
            }
        }
        if (bestEnergy / window < 1.0e-6)
        {
            continue;
        }
        audibleFrames++;
        double mean = 0.0;
        for (int i = 0; i < window; i++)
        {
            mean += audio[bestChannel][offset + i];
        }
        mean /= window;
        for (int i = 0; i < window; i++)
        {
            input->data[i] = static_cast<float>(audio[bestChannel][offset + i] - mean);
        }
        aubio_pitch_do(detector.get(), input.get(), output.get());
        const float confidence = aubio_pitch_get_confidence(detector.get());
        const float pitch = output->data[0];
        if (confidence >= 0.85f && std::isfinite(pitch) && pitch >= 0.0f && pitch <= 127.0f)
        {
            pitches.push_back(pitch);
            confidenceSum += confidence;
        }
    }
    if (pitches.empty() || pitches.size() < static_cast<size_t>(std::min(3, audibleFrames)))
    {
        return;
    }
    std::sort(pitches.begin(), pitches.end());
    const float median = pitches[pitches.size() / 2];
    int agreeing = 0;
    double total = 0.0;
    for (float pitch : pitches)
    {
        if (std::abs(pitch - median) <= 0.35f)
        {
            agreeing++;
            total += pitch;
        }
    }
    // A phrase with changing notes does not have a single sample root.
    if (agreeing >= std::max(1, static_cast<int>(std::ceil(audibleFrames * 0.8))))
    {
        result.hasRoot = true;
        result.rootMidi = static_cast<float>(total / agreeing);
        result.pitchConfidence = std::clamp(confidenceSum / static_cast<float>(pitches.size()), 0.0f, 1.0f);
    }
}

} // namespace

int FindCutZeroCrossing(const float * audio, int samples, int position, double sampleRate, int minimumPosition)
{
    if (audio == nullptr || samples <= 0 || position < 0 || position >= samples ||
        !std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
    {
        return position;
    }
    const int first = std::max({0, minimumPosition, position - static_cast<int>(sampleRate * 0.002)});
    for (int at = position; at >= first; --at)
    {
        if (audio[at] == 0.0f)
        {
            return at;
        }
        if (at > first && std::isfinite(audio[at]) && std::isfinite(audio[at - 1]) &&
            std::signbit(audio[at]) != std::signbit(audio[at - 1]))
        {
            const int candidate = std::abs(audio[at - 1]) <= std::abs(audio[at]) ? at - 1 : at;
            if (std::abs(audio[candidate]) <= std::abs(audio[position]))
            {
                return candidate;
            }
        }
    }
    return position;
}

SampleAnalysis AnalyseSample(const float * const * audio, int channels, int samples,
                            double sampleRate, SampleAnalysisKind kind, bool includeBeats)
{
    SampleAnalysis result;
    result.sampleRate = sampleRate;
    result.numSamples = samples;
    if (audio == nullptr || channels <= 0 || samples <= 0 ||
        !std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
    {
        return result;
    }
    channels = 1;
    if (kind == SampleAnalysisKind::Pitch)
    {
        FindPitch(result, audio, channels);
    }
    else
    {
        FindTransients(result, audio, channels);
        if (includeBeats)
        {
            AnalyseLoopBeats(result, audio, channels);
        }
        if (kind == SampleAnalysisKind::Vocal)
        {
            BuildVocalCuts(result, audio, channels);
        }
        else
        {
            BuildLoopGrid(result);
            BuildLoopBoundaryAnalysis(result, audio, channels);
        }
    }
    BuildGateAnalysis(result, audio, channels, kind);
    return result;
}

int LoopPlaybackEnd(const SampleAnalysis * analysis, int sourceSamples)
{
    return analysis != nullptr && analysis->numSamples == sourceSamples && analysis->loopBoundaryVersion == kLoopBoundaryAnalysisVersion &&
        analysis->loopEndConfidence >= 0.85f && analysis->loopEndSample >= 2 &&
        analysis->loopEndSample < sourceSamples ? analysis->loopEndSample : sourceSamples;
}

void BuildLoopBoundaryAnalysis(SampleAnalysis & analysis, const float * const * audio, int channels)
{
    analysis.loopBoundaryVersion = kLoopBoundaryAnalysisVersion;
    analysis.loopEndSample = analysis.numSamples;
    analysis.loopEndConfidence = 0.0f;
    analysis.loopPulseSamples = 0.0;
    const double rate = analysis.sampleRate;
    const auto & points = analysis.transients;
    if (audio == nullptr || channels < 1 || channels > 2 || !std::isfinite(rate) || rate < 8000 || rate > 192000 ||
        analysis.numSamples < rate || analysis.numSamples >= 60 * rate || points.size() < 16 || HasReliableLoopGrid(&analysis))
    {
        return;
    }
    channels = 1;
    const int end = points.back();
    if (end <= 0 || end >= analysis.numSamples) { return; }
    const int tail = analysis.numSamples - end;
    if (tail < rate * 0.02 || tail > rate * 0.2 || tail > analysis.numSamples * 0.05)
    {
        return;
    }
    std::vector<double> intervals;
    for (size_t i = 0; i < points.size(); i++)
    {
        if (points[i] < 0 || points[i] >= analysis.numSamples || (i > 0 && points[i] <= points[i - 1])) { return; }
        if (i > 0)
        {
            const int delta = points[i] - points[i - 1];
            if (delta >= rate * 0.05 && delta <= rate * 0.5) { intervals.push_back(delta); }
        }
    }
    if (intervals.size() < 12) { return; }
    std::sort(intervals.begin(), intervals.end());
    size_t clusterBegin = 0, clusterSize = 0;
    for (double centre : intervals)
    {
        const auto first = std::lower_bound(intervals.begin(), intervals.end(), centre * 0.94);
        const auto last = std::upper_bound(intervals.begin(), intervals.end(), centre * 1.06);
        const auto size = static_cast<size_t>(last - first);
        if (size > clusterSize)
        {
            clusterBegin = static_cast<size_t>(first - intervals.begin());
            clusterSize = size;
        }
    }
    if (clusterSize < intervals.size() * 0.6) { return; }
    double pulse = intervals[clusterBegin + clusterSize / 2], phase = 0.0;
    // Fit a pulse from performed onsets, not from file length or names. Trim
    // residual outliers so a flam or missed onset cannot pull the entire grid.
    std::vector<std::pair<double, int>> residuals;
    residuals.reserve(points.size());
    const size_t retained = static_cast<size_t>(std::llround(points.size() * 0.8));
    for (int iteration = 0; iteration < 8; iteration++)
    {
        residuals.clear();
        for (int point : points)
        {
            const int index = static_cast<int>(std::llround((point - phase) / pulse));
            residuals.emplace_back(std::abs(point - phase - index * pulse), point);
        }
        std::stable_sort(residuals.begin(), residuals.end(), [](const auto & a, const auto & b) { return a.first < b.first; });
        double x = 0.0, y = 0.0, xx = 0.0, xy = 0.0;
        for (size_t i = 0; i < retained; i++)
        {
            const double point = residuals[i].second;
            const double index = std::round((point - phase) / pulse);
            x += index; y += point; xx += index * index; xy += index * point;
        }
        const double denominator = retained * xx - x * x;
        if (!(denominator > 0.0)) { return; }
        const double fitted = (retained * xy - x * y) / denominator;
        phase = (y - fitted * x) / retained;
        pulse = fitted;
        if (!std::isfinite(pulse) || pulse < rate * 0.05 || pulse > rate * 0.5 || !std::isfinite(phase)) { return; }
    }
    const int count = static_cast<int>(std::llround((end - phase) / pulse));
    // Pulse continuity does not establish a bar length. Odd metres and phrase
    // lengths still close on an integer pulse when the opening fragment repeats.
    if (count < 16 || std::abs(phase) > pulse * 0.05 ||
        std::abs(end - phase - count * pulse) > pulse * 0.06 || tail < pulse * 0.15 || tail > pulse * 0.9)
    {
        return;
    }
    std::vector<bool> occupied(static_cast<size_t>(count + 1), false);
    int supported = 0;
    for (int point : points)
    {
        const int index = static_cast<int>(std::llround((point - phase) / pulse));
        if (index >= 0 && index <= count && std::abs(point - phase - index * pulse) <= pulse * 0.06)
        {
            supported++;
            occupied[static_cast<size_t>(index)] = true;
        }
    }
    const double support = static_cast<double>(supported) / points.size();
    const double coverage = static_cast<double>(std::count(occupied.begin(), occupied.end(), true)) / occupied.size();
    if (support < 0.85 || coverage < 0.85) { return; }
    const int window = std::min(tail, static_cast<int>(rate * 0.08));
    const int bin = std::max(1, static_cast<int>(std::llround(rate * 0.002)));
    const int bins = window / bin;
    if (bins < 10) { return; }
    double totalHead = 0.0, totalTail = 0.0, headSum = 0.0, tailSum = 0.0, dot = 0.0;
    double channelPower[2] {};
    for (int i = 0; i < bins; i++)
    {
        double head = 0.0, ending = 0.0;
        for (int frame = i * bin; frame < (i + 1) * bin; frame++)
        {
            for (int channel = 0; channel < channels; channel++)
            {
                const double a = audio[channel][frame], b = audio[channel][end + frame];
                if (!std::isfinite(a) || !std::isfinite(b)) { return; }
                head += a * a; ending += b * b; channelPower[channel] += a * a;
            }
        }
        head = std::sqrt(head / (bin * channels));
        ending = std::sqrt(ending / (bin * channels));
        totalHead += head * head; totalTail += ending * ending;
        headSum += head; tailSum += ending; dot += head * ending;
    }
    const double norm = std::sqrt(totalHead * totalTail);
    const double variance = std::sqrt(std::max(0.0, (totalHead - headSum * headSum / bins) *
                                                        (totalTail - tailSum * tailSum / bins)));
    if (norm < 1.0e-12 || variance < norm * 0.01 || totalTail < totalHead * 0.5 || totalTail > totalHead * 2.0 ||
        dot / norm < 0.95 || (dot - headSum * tailSum / bins) / variance < 0.75)
    {
        return;
    }
    // Match timbre too: two different notes can have identical envelopes. Work
    // on a strong channel, never a mono sum that cancels antiphase stereo.
    int fftSize = 1;
    while (fftSize * 2 <= window) { fftSize *= 2; }
    if (fftSize < 128) { return; }
    const int channel = channels == 2 && channelPower[1] > channelPower[0] ? 1 : 0;
    std::unique_ptr<aubio_fft_t, decltype(&del_aubio_fft)> fft(new_aubio_fft(static_cast<uint_t>(fftSize)), del_aubio_fft);
    Vector input(new_fvec(static_cast<uint_t>(fftSize)), del_fvec);
    std::unique_ptr<cvec_t, decltype(&del_cvec)> first(new_cvec(static_cast<uint_t>(fftSize)), del_cvec);
    std::unique_ptr<cvec_t, decltype(&del_cvec)> last(new_cvec(static_cast<uint_t>(fftSize)), del_cvec);
    if (!fft || !input || !first || !last) { return; }
    for (int pass = 0; pass < 2; pass++)
    {
        for (int i = 0; i < fftSize; i++)
        {
            const double weight = 0.5 - 0.5 * std::cos(6.283185307179586 * i / (fftSize - 1));
            input->data[i] = static_cast<float>(audio[channel][(pass == 0 ? 0 : end) + i] * weight);
        }
        aubio_fft_do(fft.get(), input.get(), pass == 0 ? first.get() : last.get());
    }
    double aa = 0.0, bb = 0.0, ab = 0.0;
    for (uint_t i = 1; i < first->length; i++)
    {
        const double a = first->norm[i], b = last->norm[i];
        aa += a * a; bb += b * b; ab += a * b;
    }
    const double spectralNorm = std::sqrt(aa * bb);
    if (!std::isfinite(spectralNorm) || spectralNorm < 1.0e-12 || ab / spectralNorm < 0.98) { return; }
    analysis.loopEndSample = end;
    analysis.loopEndConfidence = static_cast<float>(std::min({support, coverage, dot / norm, ab / spectralNorm}));
    analysis.loopPulseSamples = pulse;
}

void BuildGateAnalysis(SampleAnalysis & analysis, const float * const * audio, int channels,
                       SampleAnalysisKind kind)
{
    analysis.gateStarts = kind == SampleAnalysisKind::Vocal ? analysis.vocalStarts : analysis.transients;
    analysis.gateStrengths.clear();
    if (audio == nullptr || channels <= 0 || analysis.numSamples <= 0)
    {
        return;
    }
    channels = 1;
    const int window = std::max(1, static_cast<int>(analysis.sampleRate * 0.012));
    const int attack = std::max(1, static_cast<int>(analysis.sampleRate * 0.002));
    float maximum = 0.0f;
    for (size_t index = 0; index < analysis.gateStarts.size(); index++)
    {
        const int start = analysis.gateStarts[index];
        // Stop before a neighbouring flam so it cannot inflate this hit's score.
        const int end = std::min({analysis.numSamples, start + window,
            index + 1 < analysis.gateStarts.size() ? analysis.gateStarts[index + 1] : analysis.numSamples});
        double before = 0.0, after = 0.0, initial = 0.0;
        for (int channel = 0; channel < channels; channel++)
        {
            for (int i = std::max(0, start - window); i < start; i++)
            {
                before += audio[channel][i] * audio[channel][i];
            }
            for (int i = start; i < end; i++)
            {
                const double energy = audio[channel][i] * audio[channel][i];
                after += energy;
                if (i < start + attack)
                {
                    initial += energy;
                }
            }
        }
        before /= channels * std::max(1, std::min(start, window));
        after /= channels * std::max(1, end - start);
        initial /= channels * std::max(1, std::min(attack, end - start));
        const double contrast = std::max(0.0, after - before) / std::max(1.0e-20, after);
        const double sharpness = std::min(1.0, initial / std::max(1.0e-20, after));
        const float strength = static_cast<float>(std::sqrt(after) *
            (0.65 + 0.25 * contrast + 0.10 * sharpness));
        analysis.gateStrengths.push_back(strength);
        maximum = std::max(maximum, strength);
    }
    for (float & strength : analysis.gateStrengths)
    {
        // A 48 dB relative range gives the coarse control useful travel while
        // preserving quiet, distinct attacks at the bottom of the range.
        strength = maximum > 1.0e-12f && strength > 0.0f ?
            static_cast<float>(std::max(0.0, 1.0 + 20.0 * std::log10(strength / maximum) / 48.0)) : 0.0f;
        // Real breaks cluster near the top of a linear dB score. Expand the
        // accent end of the knob without discarding quiet ghost candidates.
        strength *= strength;
    }
}

int SnapLoopStart(const SampleAnalysis * analysis, double position, int loopLength, int maximumDistance)
{
    if (loopLength <= 0 || !std::isfinite(position))
    {
        return 0;
    }
    position = std::fmod(position, loopLength);
    if (position < 0.0)
    {
        position += loopLength;
    }
    int selected = std::min(loopLength - 1, static_cast<int>(std::llround(position)));
    double nearest = std::max(0, maximumDistance);
    if (analysis != nullptr && analysis->numSamples == loopLength && !analysis->transients.empty())
    {
        // Defaults resolve for every key during playback. The nearest point on
        // this sorted circular map is one of the two surrounding attacks.
        const auto & points = analysis->transients;
        const auto following = std::lower_bound(points.begin(), points.end(), position);
        const int after = following == points.end() ? points.front() : *following;
        const int before = following == points.begin() ? points.back() : *(following - 1);
        // Preserve the existing preference for the later source frame on ties.
        for (int onset : {std::min(before, after), std::max(before, after)})
        {
            double distance = std::abs(position - onset);
            distance = std::min(distance, loopLength - distance);
            if (distance <= nearest)
            {
                nearest = distance;
                selected = onset;
            }
        }
    }
    return selected;
}

int LoopBarCount(const SampleAnalysis * analysis)
{
    return analysis != nullptr && analysis->eighths.size() >= 9 ?
        static_cast<int>((analysis->eighths.size() - 1) / 8) : 1;
}

int DefaultLoopStart(const SampleAnalysis * analysis, int key, int loopLength, int bar)
{
    if (key < 0 || key >= 8 || loopLength <= 0)
    {
        return 0;
    }
    if (analysis != nullptr && analysis->numSamples == loopLength && analysis->eighths.size() >= 9)
    {
        const int bars = LoopBarCount(analysis);
        bar = ((bar % bars) + bars) % bars;
        return analysis->eighths[static_cast<size_t>(bar * 8 + key)] % loopLength;
    }
    return SnapLoopStart(analysis, static_cast<double>(key) * loopLength / 8.0,
                         loopLength, loopLength / 20);
}


void BuildVocalCuts(SampleAnalysis & analysis, const float * const * audio, int channels)
{
    analysis.loopBoundaryVersion = 0;
    analysis.loopEndSample = 0;
    analysis.loopEndConfidence = 0.0f;
    analysis.loopPulseSamples = 0.0;
    analysis.vocalStarts.clear();
    analysis.vocalDefaults.clear();
    analysis.eighths.clear();
    ResolveLoopBarReference(analysis); // Tempo evidence only, never vocal cut placement.
    if (audio == nullptr || channels <= 0 || analysis.numSamples <= 0 ||
        !std::isfinite(analysis.sampleRate) || analysis.sampleRate <= 0.0)
    {
        return;
    }
    channels = 1;
    const int hop = std::max(1, static_cast<int>(analysis.sampleRate * 0.002));
    const int frames = (analysis.numSamples + hop - 1) / hop;
    std::vector<double> power(static_cast<size_t>(frames), 0.0);
    for (int frame = 0; frame < frames; frame++)
    {
        const int begin = frame * hop;
        const int end = std::min(analysis.numSamples, begin + hop);
        for (int channel = 0; channel < channels; channel++)
        {
            double energy = 0.0;
            for (int at = begin; at < end; at++)
            {
                const double value = audio[channel][at];
                energy += value * value;
            }
            // Channel energy avoids cancellation in antiphase stereo vocals.
            power[static_cast<size_t>(frame)] = std::max(power[static_cast<size_t>(frame)], energy / (end - begin));
        }
    }
    auto ordered = power;
    std::sort(ordered.begin(), ordered.end());
    const double peak = ordered.back();
    // A low percentile tracks background hiss when pauses exist. A nearly
    // constant sustained vowel is content, rather than its own noise floor.
    const double quiet = ordered[ordered.size() / 10];
    const double floor = quiet < peak * 0.125 ? quiet : 0.0;
    const double gate = std::max(1.0e-12, std::max(peak * 0.00001, std::min(floor * 4.0, peak * 0.1)));
    const double leadGate = std::max(1.0e-12, std::max(floor * 1.5, gate * 0.001));
    struct Candidate { int start; int priority; };
    std::vector<Candidate> candidates;
    const auto add = [&](int frame, int priority) {
        // Backtrack through quiet consonants before the main vowel/body. Keep
        // one envelope frame of lead, without borrowing from an earlier word.
        const int earliest = std::max(0, frame - 25);
        while (frame > earliest && power[static_cast<size_t>(frame - 1)] > leadGate)
        {
            frame--;
        }
        candidates.push_back({std::max(0, (frame - 1) * hop), priority});
    };
    int begin = -1, lastActive = -1, previousEnd = -1, activeFrames = 0;
    const auto finish = [&] {
        if (begin >= 0 && (activeFrames >= 8 || frames < 8))
        {
            const int pause = previousEnd < 0 ? frames : begin - previousEnd - 1;
            add(begin, previousEnd < 0 || pause >= 80 ? 2 : 1); // 160 ms phrase pauses.
            previousEnd = lastActive;
        }
    };
    for (int frame = 0; frame < frames; frame++)
    {
        if (power[static_cast<size_t>(frame)] > gate)
        {
            if (begin < 0)
            {
                begin = frame;
                activeFrames = 0;
            }
            lastActive = frame;
            activeFrames++;
        }
        else if (begin >= 0 && frame - lastActive >= 15) // Bridge gaps shorter than 30 ms.
        {
            finish();
            begin = -1;
        }
    }
    finish();
    // Compare 20 ms energy spans, rather than individual glottal pulses from
    // the drum onset detector. Those pulses can recur every 6-15 ms in speech.
    // Only local peaks of a substantial energy rise become syllabic alternatives.
    std::vector<double> cumulative(static_cast<size_t>(frames + 1), 0.0);
    for (int frame = 0; frame < frames; frame++)
    {
        cumulative[static_cast<size_t>(frame + 1)] = cumulative[static_cast<size_t>(frame)] + power[static_cast<size_t>(frame)];
    }
    const auto mean = [&](int beginFrame, int endFrame) {
        beginFrame = std::max(0, beginFrame);
        endFrame = std::min(frames, endFrame);
        return (cumulative[static_cast<size_t>(endFrame)] - cumulative[static_cast<size_t>(beginFrame)]) /
            std::max(1, endFrame - beginFrame);
    };
    std::vector<double> novelty(static_cast<size_t>(frames), 0.0);
    for (int frame = 10; frame + 10 < frames; frame++)
    {
        const double before = mean(frame - 10, frame);
        const double after = mean(frame, frame + 10);
        if (power[static_cast<size_t>(frame)] > leadGate && after > std::max(gate * 4.0, before * 3.5))
        {
            novelty[static_cast<size_t>(frame)] = after / std::max(gate, before);
        }
    }
    for (int frame = 10; frame + 10 < frames; frame++)
    {
        if (novelty[static_cast<size_t>(frame)] <= 0.0 ||
            std::max_element(novelty.begin() + frame - 10, novelty.begin() + frame + 11) != novelty.begin() + frame)
        {
            continue;
        }
        int valley = frame;
        for (int earlier = frame - 10; earlier < frame; earlier++)
        {
            if (mean(earlier - 2, earlier + 3) < mean(valley - 2, valley + 3))
            {
                valley = earlier;
            }
        }
        candidates.push_back({std::max(0, (valley - 1) * hop), 0});
    }
    if (candidates.empty())
    {
        const auto first = std::find_if(power.begin(), power.end(), [&](double value) { return value > gate; });
        add(first == power.end() ? 0 : static_cast<int>(first - power.begin()), 2);
    }
    // Select higher-priority phrase/word starts first, suppressing nearby vowel
    // rises. Sort the final maps by source time so key order follows the vocal.
    std::stable_sort(candidates.begin(), candidates.end(), [](const Candidate & a, const Candidate & b) {
        return a.priority != b.priority ? a.priority > b.priority : a.start < b.start;
    });
    const int minimumGap = std::max(1, static_cast<int>(analysis.sampleRate * 0.075));
    for (const auto & candidate : candidates)
    {
        const int start = FindCutZeroCrossing(audio[0], analysis.numSamples, candidate.start, analysis.sampleRate);
        const auto next = std::lower_bound(analysis.vocalStarts.begin(), analysis.vocalStarts.end(), start);
        if ((next != analysis.vocalStarts.end() && *next - start < minimumGap) ||
            (next != analysis.vocalStarts.begin() && start - *(next - 1) < minimumGap))
        {
            continue;
        }
        if (analysis.vocalStarts.size() >= 4096)
        {
            break;
        }
        analysis.vocalStarts.insert(next, start);
        if (analysis.vocalDefaults.size() < 8)
        {
            analysis.vocalDefaults.push_back(start);
        }
    }
    std::sort(analysis.vocalDefaults.begin(), analysis.vocalDefaults.end());
}

int DefaultVocalStart(const SampleAnalysis * analysis, int key, int length, int alternative)
{
    if (key < 0 || key >= 8 || length <= 0 || analysis == nullptr || analysis->numSamples != length ||
        analysis->vocalStarts.empty() || analysis->vocalDefaults.empty())
    {
        return 0; // Await real content; never invent an equal-time vocal slice.
    }
    const int start = analysis->vocalDefaults[static_cast<size_t>(key) % analysis->vocalDefaults.size()];
    const int count = static_cast<int>(analysis->vocalStarts.size());
    const int first = static_cast<int>(std::lower_bound(analysis->vocalStarts.begin(), analysis->vocalStarts.end(), start) -
                                       analysis->vocalStarts.begin());
    const int selected = ((first + alternative % count) % count + count) % count;
    return analysis->vocalStarts[static_cast<size_t>(selected)];
}
