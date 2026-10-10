package com.readlater.app.tts

import java.io.File
import java.io.RandomAccessFile

/**
 * Where each frame of an MP3 starts, in bytes and in time, found by walking the
 * frame headers.
 *
 * MediaExtractor.seekTo on an MP3 guesses the byte position from the bitrate
 * (or from a Xing table that describes only the first piece of a stitched
 * file), and then reports the time it guessed, not the time it landed at. An
 * episode with inserted ads is spliced together from pieces encoded at
 * different bitrates, so after every jump (an ad skip, the skip button, a
 * speed change, resuming from pause) the transcript highlight sat at a
 * different moment from the voice. MP3 frames stand alone, so playback can
 * start at a frame boundary from here instead, at a time known exactly.
 *
 * The server's transcript times are true times (ffmpeg decodes from the
 * start), so these line up with them.
 */
class Mp3Index private constructor(
    private val offsets: IntArray,
    private val startsMs: IntArray,
    val durationMs: Long,
) {
    /** Byte offset and start time (ms) of the frame to start playing [ms] from.
     *  A couple of frames early: a frame can borrow bits from the one before
     *  it (the bit reservoir), so the first frame decoded comes out garbled. */
    fun frameAt(ms: Int): Pair<Long, Int> {
        var lo = 0
        var hi = startsMs.size - 1
        while (lo < hi) { // last frame starting at or before ms
            val mid = (lo + hi + 1) ushr 1
            if (startsMs[mid] <= ms) lo = mid else hi = mid - 1
        }
        val i = (lo - RESERVOIR_FRAMES).coerceAtLeast(0)
        return offsets[i].toLong() to startsMs[i]
    }

    companion object {
        private const val RESERVOIR_FRAMES = 2

        private val BITRATES_V1 = intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
        private val BITRATES_V2 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
        private val RATES_V1 = intArrayOf(44100, 48000, 32000)

        /** The index of an MP3 file, or null for anything else (or one too
         *  damaged to trust), which then seeks the way it always did. */
        fun build(file: File): Mp3Index? = runCatching {
            RandomAccessFile(file, "r").use { scan(Reader(it)) }
        }.getOrNull()

        private class Header(val len: Int, val samples: Int, val rate: Int, val sideInfo: Int)

        /** A Layer III frame header at [pos], or null. */
        private fun header(r: Reader, pos: Long): Header? {
            if (pos + 4 > r.length) return null
            val b1 = r.at(pos + 1); val b2 = r.at(pos + 2); val b3 = r.at(pos + 3)
            if (r.at(pos) != 0xFF || b1 and 0xE0 != 0xE0) return null
            val version = (b1 shr 3) and 3 // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
            if (version == 1 || (b1 shr 1) and 3 != 1) return null // reserved, or not Layer III
            val brIdx = (b2 shr 4) and 0xF
            val srIdx = (b2 shr 2) and 3
            if (brIdx == 0 || brIdx == 15 || srIdx == 3) return null
            val v1 = version == 3
            val kbps = (if (v1) BITRATES_V1 else BITRATES_V2)[brIdx]
            val rate = RATES_V1[srIdx] shr (if (v1) 0 else if (version == 2) 1 else 2)
            val samples = if (v1) 1152 else 576
            val len = (samples / 8) * kbps * 1000 / rate + ((b2 shr 1) and 1)
            val mono = (b3 shr 6) and 3 == 3
            val sideInfo = if (v1) (if (mono) 17 else 32) else (if (mono) 9 else 17)
            return Header(len, samples, rate, sideInfo)
        }

        /** An ID3v2 tag's full length at [pos], or 0 if there is none there. */
        private fun id3Length(r: Reader, pos: Long): Long {
            if (pos + 10 > r.length || r.at(pos) != 'I'.code || r.at(pos + 1) != 'D'.code || r.at(pos + 2) != '3'.code) return 0
            val size = (r.at(pos + 6) shl 21) or (r.at(pos + 7) shl 14) or (r.at(pos + 8) shl 7) or r.at(pos + 9)
            return 10L + size + (if (r.at(pos + 5) and 0x10 != 0) 10 else 0)
        }

        private fun tagAt(r: Reader, pos: Long, tag: String): Boolean =
            pos + tag.length <= r.length && tag.indices.all { r.at(pos + it) == tag[it].code }

        private fun scan(r: Reader): Mp3Index? {
            var pos = id3Length(r, 0)
            // Not an MP3 at all (an .m4a, an .ogg): MediaExtractor seeks those
            // exactly from their own tables, so leave them to it.
            if (header(r, pos) == null) return null
            val offsets = IntArrayBuilder()
            val starts = IntArrayBuilder()
            var timeUs = 0.0
            var skipped = 0L
            var first = true
            while (pos + 4 <= r.length) {
                val h = header(r, pos)
                // A real frame is followed by another (or the end); a stray 0xFF
                // in a mid-file tag or a damaged stretch is not.
                val next = pos + (h?.len ?: 0)
                if (h != null && h.len > 4 && (next >= r.length - 128 || header(r, next) != null)) {
                    // The Xing/Info frame up front is a header in a frame's
                    // clothing: decoders play nothing for it.
                    val silent = first && (tagAt(r, pos + 4 + h.sideInfo, "Xing") ||
                        tagAt(r, pos + 4 + h.sideInfo, "Info") || tagAt(r, pos + 36, "VBRI"))
                    first = false
                    if (!silent) {
                        offsets.add(pos.toInt())
                        starts.add((timeUs / 1000).toInt())
                        timeUs += h.samples * 1_000_000.0 / h.rate
                    }
                    pos = next
                    continue
                }
                val tag = id3Length(r, pos) // stitched pieces can each bring a tag
                if (tag > 0) { pos += tag; skipped += tag; continue }
                pos++; skipped++
            }
            // Mostly unparseable: not something to stake the position on.
            if (offsets.size < 100 || skipped > r.length / 10) return null
            if (r.length > Int.MAX_VALUE) return null
            return Mp3Index(offsets.toArray(), starts.toArray(), (timeUs / 1000).toLong())
        }
    }

    /** Byte-at-a-time reads through a sliding window: the scan moves forward a
     *  frame at a time, so it rarely leaves the window it has. */
    private class Reader(private val f: RandomAccessFile) {
        val length = f.length()
        private val buf = ByteArray(256 * 1024)
        private var start = 0L
        private var len = 0

        fun at(pos: Long): Int {
            if (pos < start || pos >= start + len) {
                start = pos
                f.seek(pos)
                len = f.read(buf).coerceAtLeast(0)
                if (len == 0) return -1
            }
            return buf[(pos - start).toInt()].toInt() and 0xFF
        }
    }

    private class IntArrayBuilder {
        private var a = IntArray(4096)
        var size = 0
            private set
        fun add(v: Int) {
            if (size == a.size) a = a.copyOf(a.size * 2)
            a[size++] = v
        }
        fun toArray(): IntArray = a.copyOf(size)
    }
}
