package io.harnessdeck.jetbrains.secrets

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe

/**
 * 基于 IntelliJ Platform [PasswordSafe] 的安全凭据存储（对接 macOS Keychain / Linux SecretService / Windows Credential Manager / KeePass）。
 */
object PasswordSafeStore {
    private const val SUBSYSTEM = "Harness Deck"

    private fun attributesFor(key: String): CredentialAttributes =
        CredentialAttributes(generateServiceName(SUBSYSTEM, key), key)

    fun get(key: String): String? =
        PasswordSafe.instance.getPassword(attributesFor(key))

    fun store(key: String, value: String) {
        PasswordSafe.instance.set(attributesFor(key), Credentials(key, value))
    }

    fun delete(key: String) {
        PasswordSafe.instance.set(attributesFor(key), null)
    }
}
