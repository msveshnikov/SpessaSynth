import { NON_CC_INDEX_OFFSET, workletMessageType } from './worklet_channel.js';
import { midiControllers } from '../../midi_parser/midi_message.js';
import { generatorTypes } from '../../soundfont/chunk/generators.js';
import { getOscillatorData } from './worklet_utilities/wavetable_oscillator.js'
import { modulatorSources } from '../../soundfont/chunk/modulators.js';
import { computeModulators } from './worklet_utilities/worklet_modulator.js'
import {
    absCentsToHz,
    timecentsToSeconds,
} from './worklet_utilities/unit_converter.js'
import { getLFOValue } from './worklet_utilities/lfo.js';
import { consoleColors } from '../../utils/other.js'
import { panVoice } from './worklet_utilities/stereo_panner.js'
import { applyVolumeEnvelope } from './worklet_utilities/volume_envelope.js'
import { applyLowpassFilter } from './worklet_utilities/lowpass_filter.js'
import { getModEnvValue } from './worklet_utilities/modulation_envelope.js'
import Module from "./cpessasynth.js";

/**
 * channel_processor.js
 * purpose: manages the channel from the AudioWorkletGlobalScope and renders the audio data
 */

const BUFFERS_PER_RENDER = 6; // left, right, reverb left, reverb right, chorus left, chorus right
const CHANNEL_CAP = 400;
const CONTROLLER_TABLE_SIZE = 147;
const MIN_NOTE_LENGTH = 0.07; // if the note is released faster than that, it forced to last that long
const CppessaSynth = Module();
let ready = false;
CppessaSynth.ready.then(() => {
    ready = true;
});

// an array with preset default values so we can quickly use set() to reset the controllers
const resetArray = new Int16Array(CONTROLLER_TABLE_SIZE);
// default values
resetArray[midiControllers.mainVolume] = 100 << 7;
resetArray[midiControllers.expressionController] = 127 << 7;
resetArray[midiControllers.pan] = 64 << 7;
resetArray[midiControllers.releaseTime] = 64 << 7;
resetArray[midiControllers.brightness] = 64 << 7;
resetArray[NON_CC_INDEX_OFFSET + modulatorSources.pitchWheel] = 8192;
resetArray[NON_CC_INDEX_OFFSET + modulatorSources.pitchWheelRange] = 2 << 7;
resetArray[NON_CC_INDEX_OFFSET + modulatorSources.channelPressure] = 127 << 7;
resetArray[NON_CC_INDEX_OFFSET + modulatorSources.channelTuning] = 0;

/**
 * @type {Float32Array[]}
 */
let workletDumpedSamplesList = [];

class ChannelProcessor extends AudioWorkletProcessor {
    /**
     * Creates a new channel mini synthesizer
     */
    constructor(options) {
        super();

        /**
         * starts from ZERO, not one. In the worklet and midi channel it starts from one and it's the dumbest thing ever...
         * @type {number}
         */
        this.channelNumber = options.processorOptions.channelNumber - 1;

        /**
         * Contains all controllers + other "not controllers" like pitch bend
         * @type {Int16Array}
         */
        this.midiControllers = new Int16Array(CONTROLLER_TABLE_SIZE);

        // in seconds, time between two samples (very, very short)
        this.sampleTime = 1 / sampleRate;

        this.resetControllers([]);

        this.tuningRatio = 1;

        /**
         * @type {{depth: number, delay: number, rate: number}}
         */
        this.channelVibrato = {rate: 0, depth: 0, delay: 0};

        /**
         * contains all the voices currently playing
         * @type {WorkletVoice[]}
         */
        this.voices = [];

        /**
         * contains sustained voices via cc 64: hold pedal
         * @type {WorkletVoice[]}
         */
        this.sustainedVoices = [];
        this.holdPedal = false;

        this.port.onmessage = e => this.handleMessage(e.data);
    }

    /**
     * @param message {WorkletMessage}
     */
    handleMessage(message)
    {
        const data = message.messageData;
        switch (message.messageType) {
            default:
                break;

            // note off
            case workletMessageType.noteOff:
                this.voices.forEach(v => {
                    if(v.midiNote !== data || v.isInRelease === true)
                    {
                        return;
                    }
                    if(this.holdPedal) {
                        this.sustainedVoices.push(v);
                    }
                    else
                    {
                        this.releaseVoice(v);
                    }
                });
                break;

            case workletMessageType.killNote:
                this.voices.forEach(v => {
                    if(v.midiNote !== data)
                    {
                        return;
                    }
                    v.modulatedGenerators[generatorTypes.releaseVolEnv] = -12000; // set release to be very short
                    this.releaseVoice(v);
                });
                break;

            case workletMessageType.noteOn:
                data.forEach(voice => {
                    const exclusive = voice.generators[generatorTypes.exclusiveClass];
                    if(exclusive !== 0)
                    {
                        this.voices.forEach(v => {
                            if(v.generators[generatorTypes.exclusiveClass] === exclusive)
                            {
                                this.releaseVoice(v);
                                v.generators[generatorTypes.releaseVolEnv] = -7200; // make the release nearly instant
                                computeModulators(v, this.midiControllers);
                            }
                        })
                    }
                    computeModulators(voice, this.midiControllers);
                    voice.currentAttenuationDb = 100;
                })
                this.voices.push(...data);
                if(this.voices.length > CHANNEL_CAP)
                {
                    this.voices.splice(0, this.voices.length - CHANNEL_CAP);
                }
                this.port.postMessage(this.voices.length);
                break;

            case workletMessageType.sampleDump:
                workletDumpedSamplesList[data.sampleID] = data.sampleData;
                // the sample maybe was loaded after the voice was sent... adjust the end position!
                this.voices.forEach(v => {
                    if(v.sample.sampleID !== data.sampleID)
                    {
                        return;
                    }
                    v.sample.end = data.sampleData.length - 1 + v.generators[generatorTypes.endAddrOffset] + (v.generators[generatorTypes.endAddrsCoarseOffset] * 32768);
                    // calculate for how long the sample has been playing and move the cursor there
                    v.sample.cursor = (v.sample.playbackStep * sampleRate) * (currentTime - v.startTime);
                    if(v.sample.loopingMode === 0) // no loop
                    {
                        if (v.sample.cursor >= v.sample.end) {
                            v.finished = true;
                        }
                    }
                    else
                    {
                        // go through modulo (adjust cursor if the sample has looped
                        if(v.sample.cursor > v.sample.loopEnd) {
                            v.sample.cursor = v.sample.cursor % (v.sample.loopEnd - v.sample.loopStart) + v.sample.loopStart - 1;
                        }
                    }
                })

                break;

            case workletMessageType.ccReset:
                this.resetControllers(data);
                break;

            case workletMessageType.ccChange:
                // special case: hold pedal
                if(data[0] === midiControllers.sustainPedal) {
                    if (data[1] >= 64)
                    {
                        this.holdPedal = true;
                    }
                    else
                    {
                        this.holdPedal = false;
                        this.sustainedVoices.forEach(v => {
                            this.releaseVoice(v)
                        });
                        this.sustainedVoices = [];
                    }
                }
                this.midiControllers[data[0]] = data[1];
                this.voices.forEach(v => computeModulators(v, this.midiControllers));
                break;

            case workletMessageType.setChannelVibrato:
                this.channelVibrato = data;
                break;

            case workletMessageType.clearCache:
                if(workletDumpedSamplesList.length > 0) {
                    workletDumpedSamplesList = [];
                }
                break;

            case workletMessageType.stopAll:
                if(data === 1)
                {
                    // force stop all
                    this.voices = [];
                    this.port.postMessage(0);
                }
                else
                {
                    this.voices.forEach(v => {
                        if(v.isInRelease) return;
                        this.releaseVoice(v)
                    });
                }
                break;

            case workletMessageType.killNotes:
                this.voices.splice(0, data); // starting from 0 (earliest
                this.port.postMessage(this.voices.length);
                break;
        }
    }

    /**
     * Stops the voice
     * @param voice {WorkletVoice} the voice to stop
     */
    releaseVoice(voice)
    {
        voice.releaseStartTime = currentTime;
        // check if the note is shorter than the min note time, if so, extend it
        if(voice.releaseStartTime - voice.startTime < MIN_NOTE_LENGTH)
        {
            voice.releaseStartTime = voice.startTime + MIN_NOTE_LENGTH;
        }
    }

    /**
     * Syntesizes the voice to buffers
     * @param inputs {Float32Array[][]} required by WebAudioAPI
     * @param outputs {Float32Array[][]} the outputs to write to, only the first 2 channels are populated
     * @returns {boolean} true
     */
    process(inputs, outputs) {
        if(!ready)
        {
            return true;
        }
        const channels = outputs[0];
        const reverb = outputs[1];
        const chorus = outputs[2];
        const channelSampleLength = channels[0].length;
        const sizePerChannel = channelSampleLength * 4; // 4 bytes per float
        // allocate the memory as a big chunk of left then right data
        const renderOutPointer = CppessaSynth._malloc(sizePerChannel * BUFFERS_PER_RENDER);
        // get the pointers
        const leftChannelPointer = renderOutPointer;
        const rightChannelPointer = leftChannelPointer + sizePerChannel;

        const leftReverbPointer = rightChannelPointer + sizePerChannel;
        const rightReverbPointer = leftReverbPointer + sizePerChannel;

        const leftChorusPointer = rightReverbPointer + sizePerChannel;
        const rightChorusPointer = leftChorusPointer + sizePerChannel;

        // render
        CppessaSynth._renderAudio(this.channelNumber, channelSampleLength,
            leftChannelPointer, rightChannelPointer,
            leftReverbPointer, rightReverbPointer,
            leftChorusPointer, rightChorusPointer);

        // copy the rendered data to out

        // dry audio
        channels[0].set(new Float32Array(CppessaSynth.HEAPU8.buffer, leftChannelPointer, channelSampleLength));
        channels[1].set(new Float32Array(CppessaSynth.HEAPU8.buffer, rightChannelPointer, channelSampleLength));
        console.log(channels[1])

        // reverb
        reverb[0].set(new Float32Array(CppessaSynth.HEAPU8.buffer, leftReverbPointer, channelSampleLength));
        reverb[1].set(new Float32Array(CppessaSynth.HEAPU8.buffer, rightReverbPointer, channelSampleLength));

        // chorus
        chorus[0].set(new Float32Array(CppessaSynth.HEAPU8.buffer, leftChorusPointer, channelSampleLength));
        chorus[1].set(new Float32Array(CppessaSynth.HEAPU8.buffer, rightChorusPointer, channelSampleLength));

        // free memory
        CppessaSynth._free(renderOutPointer);
        return true;
    }

    /**
     * Renders a voice to the stereo output buffer
     * @param voice {WorkletVoice} the voice to render
     * @param output {Float32Array[]} the output buffer
     * @param reverbOutput {Float32Array[]} output for reverb
     * @param chorusOutput {Float32Array[]} output for chorus
     */
    renderVoice(voice, output, reverbOutput, chorusOutput)
    {
        // if no matching sample, perhaps it's still being loaded..? worklet_channel.js line 256
        if(workletDumpedSamplesList[voice.sample.sampleID] === undefined)
        {
            return;
        }

        // check if release
        if(!voice.isInRelease) {
            // if not in release, check if the release time is
            if (currentTime >= voice.releaseStartTime) {
                voice.releaseStartModEnv = voice.currentModEnvValue;
                voice.isInRelease = true;
            }
        }


        // if the initial attenuation is more than 100dB, skip the voice (it's silent anyways)
        if(voice.modulatedGenerators[generatorTypes.initialAttenuation] > 2500)
        {
            if(voice.isInRelease)
            {
                voice.finished = true;
            }
            return;
        }

        // TUNING

        // calculate tuning
        let cents = voice.modulatedGenerators[generatorTypes.fineTune]
            + this.midiControllers[NON_CC_INDEX_OFFSET + modulatorSources.channelTuning]
            + this.midiControllers[NON_CC_INDEX_OFFSET + modulatorSources.channelTranspose];
        let semitones = voice.modulatedGenerators[generatorTypes.coarseTune];

        // calculate tuning by key
        cents += (voice.targetKey - voice.sample.rootKey) * voice.modulatedGenerators[generatorTypes.scaleTuning];

        // vibrato LFO
        const vibratoDepth = voice.modulatedGenerators[generatorTypes.vibLfoToPitch];
        if(vibratoDepth > 0)
        {
            const vibStart = voice.startTime + timecentsToSeconds(voice.modulatedGenerators[generatorTypes.delayVibLFO]);
            const vibFreqHz = absCentsToHz(voice.modulatedGenerators[generatorTypes.freqVibLFO]);
            const lfoVal = getLFOValue(vibStart, vibFreqHz, currentTime);
            if(lfoVal)
            {
                cents += lfoVal * vibratoDepth;
            }
        }

        // lowpass frequency
        let lowpassCents = voice.modulatedGenerators[generatorTypes.initialFilterFc];

        // mod LFO
        const modPitchDepth = voice.modulatedGenerators[generatorTypes.modLfoToPitch];
        const modVolDepth = voice.modulatedGenerators[generatorTypes.modLfoToVolume];
        const modFilterDepth = voice.modulatedGenerators[generatorTypes.modLfoToFilterFc];
        let modLfoCentibels = 0;
        if(modPitchDepth + modFilterDepth + modVolDepth > 0)
        {
            const modStart = voice.startTime + timecentsToSeconds(voice.modulatedGenerators[generatorTypes.delayModLFO]);
            const modFreqHz = absCentsToHz(voice.modulatedGenerators[generatorTypes.freqModLFO]);
            const modLfoValue = getLFOValue(modStart, modFreqHz, currentTime);
            cents += modLfoValue * modPitchDepth;
            modLfoCentibels = modLfoValue * modVolDepth;
            lowpassCents += modLfoValue * modFilterDepth;
        }

        // channel vibrato (GS NRPN)
        if(this.channelVibrato.depth > 0)
        {
            const channelVibrato = getLFOValue(voice.startTime + this.channelVibrato.delay, this.channelVibrato.rate, currentTime);
            if(channelVibrato)
            {
                cents += channelVibrato * this.channelVibrato.depth;
            }
        }

        // mod env
        const modEnvPitchDepth = voice.modulatedGenerators[generatorTypes.modEnvToPitch];
        const modEnvFilterDepth = voice.modulatedGenerators[generatorTypes.modEnvToFilterFc];
        const modEnv = getModEnvValue(voice, currentTime);
        lowpassCents += modEnv * modEnvFilterDepth;
        cents += modEnv * modEnvPitchDepth;

        // finally calculate the playback rate
        const centsTotal = ~~(cents + semitones * 100);
        if(centsTotal !== voice.currentTuningCents)
        {
            voice.currentTuningCents = centsTotal;
            voice.currentTuningCalculated = Math.pow(2, centsTotal / 1200);
        }

        // PANNING
        const pan = ( (Math.max(-500, Math.min(500, voice.modulatedGenerators[generatorTypes.pan] )) + 500) / 1000) ; // 0 to 1

        // SYNTHESIS
        const bufferOut = new Float32Array(output[0].length);

        // wavetable oscillator
        getOscillatorData(voice, workletDumpedSamplesList[voice.sample.sampleID], bufferOut);


        // lowpass filter
        applyLowpassFilter(voice, bufferOut, lowpassCents);

        // volenv
        applyVolumeEnvelope(voice, bufferOut, currentTime, modLfoCentibels, this.sampleTime);

        // pan the voice and write out
        panVoice(pan, bufferOut, output,
            reverbOutput, voice.modulatedGenerators[generatorTypes.reverbEffectsSend],
            chorusOutput, voice.modulatedGenerators[generatorTypes.chorusEffectsSend]);
    }

    /**
     * Resets all controllers
     * @param excluded {number[]}
     */
    resetControllers(excluded)
    {
        // save excluded controllers as reset doesn't affect them
        let excludedCCvalues = excluded.map(ccNum => {
            return {
                ccNum: ccNum,
                ccVal: this.midiControllers[ccNum]
            }
        });
        // transpose does not get affected either so save
        const transpose = this.midiControllers[NON_CC_INDEX_OFFSET + modulatorSources.channelTranspose];

        // reset the array
        this.midiControllers.set(resetArray);
        this.channelVibrato = {rate: 0, depth: 0, delay: 0};
        this.holdPedal = false;

        // restore unaffected
        this.midiControllers[NON_CC_INDEX_OFFSET + modulatorSources.channelTranspose] = transpose;
        excludedCCvalues.forEach((cc) => {
            this.midiControllers[cc.ccNum] = cc.ccVal;
        })

    }

}


registerProcessor("worklet-channel-processor", ChannelProcessor);
console.log("%cProcessor succesfully registered!", consoleColors.recognized);