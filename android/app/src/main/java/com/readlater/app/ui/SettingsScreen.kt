package com.readlater.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.readlater.app.ReadLaterApp
import kotlinx.coroutines.launch
import java.util.Locale

/** Pre-filled default so a fresh install only needs username + password. */
private const val DEFAULT_SERVER_URL = "https://readlater-mbent.fly.dev"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as ReadLaterApp
    val settings = app.settings
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    var url by remember { mutableStateOf(settings.serverUrl.ifBlank { DEFAULT_SERVER_URL }) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var token by remember { mutableStateOf(settings.token) }
    var rate by remember { mutableStateOf(settings.ttsSpeechRate) }
    var busy by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }

    fun save() {
        settings.serverUrl = url
        settings.token = token
        url = settings.serverUrl // reflect trailing-slash trimming
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text("Server", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Server URL") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("Username") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )
            Text(
                text = "Signing in fetches your account's API token and stores it — " +
                    "your password is not saved on this device.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = !busy && username.isNotBlank() && password.isNotBlank(),
                    onClick = {
                        scope.launch {
                            busy = true
                            testResult = try {
                                val newToken = app.apiClient.login(url, username.trim(), password)
                                settings.serverUrl = url
                                settings.token = newToken
                                token = newToken
                                password = ""
                                url = settings.serverUrl
                                "Signed in as ${username.trim()} — connected."
                            } catch (e: Exception) {
                                "Sign-in failed: ${e.message ?: "unknown error"}"
                            }
                            busy = false
                        }
                    }
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text("Sign in")
                    }
                }
                OutlinedButton(
                    enabled = !busy,
                    onClick = {
                        save()
                        scope.launch {
                            busy = true
                            testResult = try {
                                if (app.apiClient.health()) {
                                    "Connected — server is healthy."
                                } else {
                                    "Server responded, but reported not healthy."
                                }
                            } catch (e: Exception) {
                                "Connection failed: ${e.message ?: "unknown error"}"
                            }
                            busy = false
                        }
                    }
                ) {
                    Text("Test connection")
                }
            }
            testResult?.let { result ->
                Text(
                    text = result,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (result.startsWith("Connected") || result.startsWith("Signed in")) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    }
                )
            }

            OutlinedTextField(
                value = token,
                onValueChange = {
                    token = it
                    settings.token = it
                },
                label = { Text("Access token (advanced — set by Sign in)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            HorizontalDivider()

            Text("Text to speech", style = MaterialTheme.typography.titleMedium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Speech rate",
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f)
                )
                IconButton(
                    enabled = rate > 0.5f,
                    onClick = {
                        rate = (rate - 0.25f).coerceAtLeast(0.5f)
                        settings.ttsSpeechRate = rate
                    }
                ) {
                    Icon(Icons.Filled.Remove, contentDescription = "Slower")
                }
                Text(String.format(Locale.US, "%.2f×", rate))
                IconButton(
                    enabled = rate < 2.0f,
                    onClick = {
                        rate = (rate + 0.25f).coerceAtMost(2.0f)
                        settings.ttsSpeechRate = rate
                    }
                ) {
                    Icon(Icons.Filled.Add, contentDescription = "Faster")
                }
            }

            HorizontalDivider()

            Text("About", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "ReadLater is a self-hosted read-it-later client. Save articles with " +
                    "the ReadLater Firefox extension (or email them in) and they sync here " +
                    "for offline reading, highlighting and listening. Sign in with your " +
                    "account above; create accounts on the server's /signup page.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
