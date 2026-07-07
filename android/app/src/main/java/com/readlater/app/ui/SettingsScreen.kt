package com.readlater.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import android.speech.tts.TextToSpeech
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.unit.sp
import com.readlater.app.BuildConfig
import com.readlater.app.ReadLaterApp
import com.readlater.app.tts.TtsService
import kotlinx.coroutines.launch
import java.util.Locale

/** Pre-filled default so a fresh install only needs username + password. */
private const val DEFAULT_SERVER_URL = "https://readlater-mbent.fly.dev"

private const val SHERPA_ENGINE = "com.k2fsa.sherpa.onnx.tts.engine"

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

            // Server voice (Kokoro) — higher-quality audio synthesized on the
            // server and streamed to the app; falls back to the device engine
            // when audio isn't ready yet (and asks the server to generate it).
            var serverVoice by remember { mutableStateOf(settings.useServerVoice) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Server voice (Kokoro)", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Higher-quality neural voice, synthesized on the server. " +
                            "Falls back to the device voice while audio is being prepared.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(checked = serverVoice, onCheckedChange = {
                    serverVoice = it
                    settings.useServerVoice = it
                })
            }
            if (!serverVoice) {
                Text(
                    "With server voice off, the engine and voice below are used.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Engine + voice pickers. A probe TextToSpeech instance (recreated
            // when the engine changes) enumerates voices and plays previews.
            var enginePref by remember { mutableStateOf(settings.ttsEngine) }
            var voicePref by remember { mutableStateOf(settings.ttsVoice) }
            var engines by remember { mutableStateOf<List<TextToSpeech.EngineInfo>>(emptyList()) }
            var voiceNames by remember { mutableStateOf<List<String>>(emptyList()) }
            var probe by remember { mutableStateOf<TextToSpeech?>(null) }

            val resolvedEngine = enginePref.ifBlank {
                if (runCatching { context.packageManager.getPackageInfo(SHERPA_ENGINE, 0) }.isSuccess) SHERPA_ENGINE else ""
            }
            DisposableEffect(resolvedEngine) {
                var instance: TextToSpeech? = null
                val listener = TextToSpeech.OnInitListener { status ->
                    if (status == TextToSpeech.SUCCESS) {
                        probe = instance
                        engines = instance?.engines ?: emptyList()
                        voiceNames = runCatching {
                            instance?.voices
                                ?.filter { it.locale.language == Locale.getDefault().language }
                                ?.map { it.name }?.sorted()
                        }.getOrNull() ?: emptyList()
                    }
                }
                instance = if (resolvedEngine.isBlank()) TextToSpeech(context, listener)
                else TextToSpeech(context, listener, resolvedEngine)
                onDispose {
                    probe = null
                    instance?.shutdown()
                }
            }

            var engineMenuOpen by remember { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Engine", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Box {
                    OutlinedButton(onClick = { engineMenuOpen = true }) {
                        Text(
                            engines.firstOrNull { it.name == resolvedEngine }?.label
                                ?: if (enginePref.isBlank()) "Auto" else enginePref
                        )
                    }
                    DropdownMenu(expanded = engineMenuOpen, onDismissRequest = { engineMenuOpen = false }) {
                        DropdownMenuItem(text = { Text("Auto (prefer neural)") }, onClick = {
                            enginePref = ""; voicePref = ""
                            settings.ttsEngine = ""; settings.ttsVoice = ""
                            engineMenuOpen = false
                        })
                        engines.forEach { e ->
                            DropdownMenuItem(text = { Text(e.label) }, onClick = {
                                enginePref = e.name; voicePref = ""
                                settings.ttsEngine = e.name; settings.ttsVoice = ""
                                engineMenuOpen = false
                            })
                        }
                    }
                }
            }

            var voiceMenuOpen by remember { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Voice", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Box {
                    OutlinedButton(onClick = { voiceMenuOpen = true }) {
                        Text(if (voicePref.isBlank()) "Auto (best quality)" else voicePref, maxLines = 1)
                    }
                    DropdownMenu(expanded = voiceMenuOpen, onDismissRequest = { voiceMenuOpen = false }) {
                        DropdownMenuItem(text = { Text("Auto (best quality)") }, onClick = {
                            voicePref = ""; settings.ttsVoice = ""
                            voiceMenuOpen = false
                        })
                        voiceNames.forEach { v ->
                            DropdownMenuItem(text = { Text(v) }, onClick = {
                                voicePref = v; settings.ttsVoice = v
                                voiceMenuOpen = false
                            })
                        }
                    }
                }
            }

            OutlinedButton(onClick = {
                val p = probe ?: return@OutlinedButton
                if (voicePref.isNotBlank()) {
                    runCatching { p.voices?.firstOrNull { it.name == voicePref } }.getOrNull()
                        ?.let { p.voice = it }
                }
                p.setSpeechRate(rate)
                p.speak(
                    "This is how your articles will sound in ReadLater.",
                    TextToSpeech.QUEUE_FLUSH, null, "preview"
                )
            }) {
                Text("Preview voice")
            }
            Text(
                text = "Voice changes apply when playback next starts. Install the sherpa " +
                    "neural engine from Settings on the web app for the best offline voice.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

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

            Text("Background playback", style = MaterialTheme.typography.titleMedium)
            val powerManager = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
            // recomputed whenever the screen recomposes (e.g. returning from the
            // system dialog) so the status reflects the current grant.
            var batteryChecks by remember { mutableStateOf(0) }
            val ignoringBattery = remember(batteryChecks) {
                powerManager.isIgnoringBatteryOptimizations(context.packageName)
            }
            Text(
                text = if (ignoringBattery)
                    "Battery optimization is off for Earmark — playback should keep running in the background."
                else
                    "Android may stop playback when Earmark is in the background. Allow it to run unrestricted so listening isn't interrupted.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (!ignoringBattery) {
                Button(onClick = {
                    runCatching {
                        context.startActivity(
                            android.content.Intent(
                                android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                android.net.Uri.parse("package:${context.packageName}")
                            )
                        )
                    }
                    batteryChecks++
                }) { Text("Allow background playback") }
            } else {
                Text("Allowed ✓", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            }

            HorizontalDivider()

            Text("About", style = MaterialTheme.typography.titleMedium)
            var latest by remember { mutableStateOf<Pair<String, Int>?>(null) }
            LaunchedEffect(Unit) { latest = app.apiClient.latestAppVersion() }
            val updateAvailable = (latest?.second ?: 0) > BuildConfig.VERSION_CODE
            Text(
                text = "Version ${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})" + when {
                    latest == null -> ""
                    updateAvailable -> " — update available: ${latest?.first} (build ${latest?.second})"
                    else -> " — up to date"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (updateAvailable) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurface
            )
            OutlinedButton(onClick = {
                runCatching {
                    context.startActivity(
                        android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse("${settings.serverUrl.ifBlank { DEFAULT_SERVER_URL }}/app.apk")
                        )
                    )
                }
            }) {
                Text(if (updateAvailable) "Download update" else "Download latest APK")
            }
            Text(
                text = "Earmark is a self-hosted read-it-later client. Save articles with " +
                    "the ReadLater Firefox extension (or email them in) and they sync here " +
                    "for offline reading, highlighting and listening. Sign in with your " +
                    "account above; create accounts on the server's /signup page.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            HorizontalDivider()

            // Live TTS event log — makes voice problems diagnosable.
            var showLog by remember { mutableStateOf(false) }
            val log by TtsService.debugLog.collectAsState()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Voice diagnostics", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { showLog = !showLog }) { Text(if (showLog) "Hide" else "Show") }
            }
            if (showLog) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        val cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                            as android.content.ClipboardManager
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("tts-log", log.joinToString("\n")))
                        scope.launch { snackbarHostState.showSnackbar("Log copied") }
                    }) { Text("Copy") }
                    OutlinedButton(onClick = { TtsService.debugLog.value = emptyList() }) { Text("Clear") }
                }
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = if (log.isEmpty()) "No TTS events yet — press play on an article."
                        else log.takeLast(60).joinToString("\n"),
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            fontSize = 11.sp
                        ),
                        modifier = Modifier.padding(10.dp)
                    )
                }
            }
        }
    }
}
