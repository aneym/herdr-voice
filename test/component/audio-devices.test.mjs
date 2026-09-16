/**
 * Component test: the audio layer's platform seams, without any audio hardware.
 *
 * Device enumeration and the player's argument list run only on a real Mac with
 * a real microphone, which means in practice they are never exercised by a test
 * — and they are exactly the places where a silent failure hides. Both have bitten
 * this project already: ffplay rejecting `-ac` killed audio output for days
 * because every play exited 1 unseen, and picking a virtual device gives a
 * microphone that connects happily and hears nothing.
 *
 * So the parsing runs against recorded `ffmpeg -list_devices` output and the
 * argument lists are asserted directly. No devices, no permissions, no sound.
 */
import { parseAvfoundationDevices, captureArgs, playerArgs, MicCapture } from '../../src/audio.js'

// Recorded from `ffmpeg -f avfoundation -list_devices true -i ""`.
const LIST_DEVICES_OUTPUT = `
[AVFoundation indev @ 0x7f8e1c004f80] AVFoundation video devices:
[AVFoundation indev @ 0x7f8e1c004f80] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8e1c004f80] [1] Capture screen 0
[AVFoundation indev @ 0x7f8e1c004f80] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8e1c004f80] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7f8e1c004f80] [1] Microsoft Teams Audio
[AVFoundation indev @ 0x7f8e1c004f80] [2] BlackHole 2ch
`

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- enumeration ----
const devices = parseAvfoundationDevices(LIST_DEVICES_OUTPUT)
check(
  'only the audio devices are parsed, never the cameras',
  same(devices, [
    { index: 0, name: 'MacBook Pro Microphone' },
    { index: 1, name: 'Microsoft Teams Audio' },
    { index: 2, name: 'BlackHole 2ch' },
  ]),
  JSON.stringify(devices)
)
check('no devices at all parses to an empty list, not a crash', same(parseAvfoundationDevices(''), []))
check(
  'a machine that has never granted microphone access lists nothing',
  same(parseAvfoundationDevices('[AVFoundation indev @ 0x0] AVFoundation video devices:\n[0] FaceTime HD Camera\n'), [])
)

// ---- selection ----
// A virtual device enumerates like any other and then captures silence, so
// "connected but hears nothing" is the failure this ordering prevents.
check(
  'a real microphone is preferred over a virtual one',
  MicCapture.pickDevice(devices)?.name === 'MacBook Pro Microphone',
  MicCapture.pickDevice(devices)?.name
)
check(
  'a virtual device is never picked, even when listed first',
  MicCapture.pickDevice([
    { index: 0, name: 'Microsoft Teams Audio' },
    { index: 1, name: 'External Microphone' },
  ])?.name === 'External Microphone'
)
check(
  'only virtual devices reports nothing rather than picking one',
  MicCapture.pickDevice([
    { index: 0, name: 'BlackHole 2ch' },
    { index: 1, name: 'ZoomAudioDevice' },
  ]) === null
)
check('an unrecognised but real device is still usable', MicCapture.pickDevice([{ index: 0, name: 'Scarlett Solo' }])?.name === 'Scarlett Solo')

// ---- the argument lists ----
const cap = captureArgs({ device: ':1', sampleRate: 24000 })
check('capture asks avfoundation for the requested device', cap.join(' ').includes('-f avfoundation -i :1'), cap.join(' '))
check('capture requests mono PCM16 at the session rate', cap.join(' ').includes('-ar 24000 -ac 1 -f s16le'))

const play = playerArgs({ sampleRate: 24000 })
// ffplay rejects -ac and exits 1 without playing anything, and the exit code is
// not surfaced anywhere the user would see it. This is that bug, pinned.
check('playback does NOT pass -ac, which ffplay rejects', !play.includes('-ac'), play.join(' '))
check('playback sets the channel count the way ffplay accepts', play.join(' ').includes('-ch_layout mono'))
check('playback reads raw PCM16 from the pipe at the session rate', play.join(' ').includes('-f s16le -ar 24000'))



// ---- Windows (dshow) seam ----
// Recorded from `ffmpeg -f dshow -list_devices true -i dummy` on the PC.
const DSHOW_OUTPUT = `
[dshow @ 0000022865a15000] "OBS Virtual Camera" (none)
[dshow @ 0000022865a15000]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 0000022865a15000] "Headset Microphone (Fractal Scape Dongle)" (audio)
[dshow @ 0000022865a15000]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{E0DAA23C-8FD8-4523-B2D4-8FC71493DD67}"
[dshow @ 0000022865a15000] "Microphone (Steam Streaming Microphone)" (audio)
[dshow @ 0000022865a15000]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{C9342CA2-287B-4070-B759-4CF56BFAAF1A}"
Error opening input file dummy.
`
const { parseDshowDevices, deviceSpec } = await import('../../src/audio.js')
const dshow = parseDshowDevices(DSHOW_OUTPUT)
check(
  'dshow: only audio devices are parsed, never the virtual camera',
  same(dshow, [
    { index: 0, name: 'Headset Microphone (Fractal Scape Dongle)' },
    { index: 1, name: 'Microphone (Steam Streaming Microphone)' },
  ]),
  JSON.stringify(dshow)
)
check(
  'dshow: the Steam Streaming loopback is never picked over the headset',
  MicCapture.pickDevice(dshow.slice().reverse())?.name === 'Headset Microphone (Fractal Scape Dongle)',
  MicCapture.pickDevice(dshow.slice().reverse())?.name
)
check(
  'dshow: only a virtual device present means no microphone',
  MicCapture.pickDevice([dshow[1]]) === null
)
check(
  'dshow addresses the device by name, avfoundation by index',
  deviceSpec(dshow[0], 'win32') === 'audio=Headset Microphone (Fractal Scape Dongle)' &&
    deviceSpec({ index: 2, name: 'x' }, 'darwin') === ':2'
)
const winArgs = captureArgs({ device: 'audio=Headset Microphone (Fractal Scape Dongle)', platform: 'win32' })
check(
  'win32 capture uses dshow with a short audio buffer and the same PCM16 mono output',
  winArgs.includes('dshow') &&
    winArgs[winArgs.indexOf('-audio_buffer_size') + 1] === '50' &&
    !winArgs.includes('avfoundation') &&
    winArgs.slice(-7).join(' ') === '-ar 24000 -ac 1 -f s16le -',
  winArgs.join(' ')
)

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
