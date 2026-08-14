package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bookkeeping half of `NearbyManager`'s receive path, extracted so the one rule that
 * cannot be tested through the Nearby stack can be tested at all: a reader thread that
 * finishes must only end *its own* transmission.
 *
 * The sequence that used to lose a whole transmission: `tx-stop`(S1) arrives over BYTES and
 * ends S1 while reader thread T1 is still draining its pipe; the user taps again and S2
 * opens; T1 then hits EOF and its `finally` removed whatever was mapped for that peer — S2 —
 * while reporting S1 as stopped. The engine dropped the peer from `incoming` and discarded
 * every frame of the second transmission, silently, until the next `tx-start`.
 */
class IncomingStreamsTest {

    @Test
    fun `a peer with nothing incoming has nothing to end`() {
        val streams = IncomingStreams()

        assertNull(streams.end("a"))
    }

    @Test
    fun `ending a peer's transmission reports its stream id exactly once`() {
        val streams = IncomingStreams()
        streams.open("a", "s1")

        assertEquals("s1", streams.end("a")?.streamId)
        assertNull(streams.end("a"))
    }

    @Test
    fun `a reader that finishes after its own transmission ended reports nothing`() {
        val streams = IncomingStreams()
        val first = streams.open("a", "s1")

        // tx-stop over BYTES got there first.
        assertEquals("s1", streams.end("a")?.streamId)

        assertFalse(streams.endIfCurrent("a", first))
    }

    @Test
    fun `a finished reader never ends the transmission that replaced it`() {
        val streams = IncomingStreams()
        val first = streams.open("a", "s1")
        streams.end("a")
        val second = streams.open("a", "s2")

        // The STREAM payload of the first transmission only now reaches EOF.
        assertFalse(streams.endIfCurrent("a", first))

        // The second transmission is untouched and still endable by its own reader.
        assertTrue(streams.endIfCurrent("a", second))
    }

    @Test
    fun `two unannounced transmissions in a row are told apart by identity, not by stream id`() {
        val streams = IncomingStreams()
        // No tx-start arrived for either, so both carry the same fallback stream id.
        val first = streams.open("a", "unknown")
        streams.end("a")
        val second = streams.open("a", "unknown")

        assertFalse(streams.endIfCurrent("a", first))
        assertTrue(streams.endIfCurrent("a", second))
    }

    @Test
    fun `clear drops every peer`() {
        val streams = IncomingStreams()
        val entry = streams.open("a", "s1")
        streams.open("b", "s2")

        streams.clear()

        assertNull(streams.end("b"))
        assertFalse(streams.endIfCurrent("a", entry))
    }
}
