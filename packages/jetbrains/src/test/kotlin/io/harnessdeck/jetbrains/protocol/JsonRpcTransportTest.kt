package io.harnessdeck.jetbrains.protocol

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class JsonRpcTransportTest {

    @Test
    fun `bidirectional request and notification round-trip`() {
        val aToBOut = PipedOutputStream()
        val bIn = PipedInputStream(aToBOut)
        val bToAOut = PipedOutputStream()
        val aIn = PipedInputStream(bToAOut)

        val notificationsOnA = CopyOnWriteArrayList<Pair<String, JsonObject>>()

        val peerB = JsonRpcTransport(
            input = bIn,
            output = bToAOut,
            onRequest = { method, params ->
                if (method == "echo") {
                    CompletableFuture.completedFuture(params)
                } else {
                    CompletableFuture.failedFuture(IllegalArgumentException("Unknown method $method"))
                }
            },
            onNotification = { _, _ -> },
        )

        val peerA = JsonRpcTransport(
            input = aIn,
            output = aToBOut,
            onRequest = { _, _ -> CompletableFuture.completedFuture(JsonObject()) },
            onNotification = { method, params -> notificationsOnA += method to params },
        )

        try {
            val res = peerA.request("echo", JsonObject().apply { addProperty("hello", "idea") })
                .get(5, TimeUnit.SECONDS)
                .asJsonObject
            assertEquals("idea", res.get("hello").asString)

            peerB.notify("ide/postToWebview", JsonObject().apply { addProperty("type", "snapshot") })
            val deadline = System.currentTimeMillis() + 3_000
            while (notificationsOnA.isEmpty() && System.currentTimeMillis() < deadline) {
                Thread.sleep(15)
            }
            assertEquals(1, notificationsOnA.size)
            assertEquals("ide/postToWebview", notificationsOnA[0].first)
            assertEquals("snapshot", notificationsOnA[0].second.get("type").asString)
        } finally {
            peerA.close()
            peerB.close()
        }
    }

    @Test
    fun `parses ResolvedDiffSpec variants from JSON`() {
        val pairJson = JsonParser.parseString(
            """
            {
              "kind": "pair",
              "path": "/repo/Demo.kt",
              "title": "Demo.kt",
              "left": { "kind": "virtual", "path": "/repo/Demo.kt", "label": "before", "content": "old" },
              "right": { "kind": "disk", "path": "/repo/Demo.kt" }
            }
            """.trimIndent(),
        ).asJsonObject
        val pair = ResolvedDiffSpec.fromJson(pairJson) as ResolvedDiffSpec.Pair
        assertEquals("/repo/Demo.kt", pair.path)
        assertTrue(pair.left is DiffSideSpec.Virtual)
        assertEquals("old", (pair.left as DiffSideSpec.Virtual).content)
        assertTrue(pair.right is DiffSideSpec.Disk)

        val unifiedJson = JsonParser.parseString(
            """
            { "kind": "unified", "path": "/repo/a.txt", "patchText": "--- a\n+++ a\n" }
            """.trimIndent(),
        ).asJsonObject
        val unified = ResolvedDiffSpec.fromJson(unifiedJson) as ResolvedDiffSpec.Unified
        assertEquals("--- a\n+++ a\n", unified.patchText)

        val emptyJson = EditorStateChangedParams(
            activeEditor = null,
            includeActiveEditor = true,
        ).toJsonObject()
        assertTrue(emptyJson.get("activeEditor").isJsonNull)
        assertNull(StatusBarSnapshot.fromJson(JsonParser.parseString("""{"backendName":"DeepSeek","status":{"kind":"idle"}}""").asJsonObject).modelLabel)
    }
}
