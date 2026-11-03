package com.readlater.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.fromHtml
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** An episode whose show notes to show: by guid, or by the article it became. */
data class NotesTarget(
    val feedId: String,
    val guid: String?,
    val articleId: String?,
    val title: String,
    val showTitle: String?,
    val imageUrl: String?,
    /** "Oct 12 · 42m" — whatever the row showed. */
    val meta: String,
    /** The sheet's button, e.g. "Process" or "Open transcript"; none when null. */
    val actionLabel: String? = null,
    val onAction: (() -> Unit)? = null,
)

/**
 * A podcast episode's show notes, from its feed, in a bottom sheet. Links in
 * the notes open in the browser.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EpisodeNotesSheet(
    target: NotesTarget,
    load: suspend () -> Result<String>,
    onDismiss: () -> Unit,
) {
    var notes by remember(target) { mutableStateOf<String?>(null) }
    var error by remember(target) { mutableStateOf<String?>(null) }
    var attempt by remember(target) { mutableIntStateOf(0) }
    LaunchedEffect(target, attempt) {
        error = null
        load().onSuccess { notes = it }.onFailure { error = it.message ?: "unknown error" }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 32.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(64.dp).clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                ) {
                    if (target.imageUrl != null) {
                        coil.compose.AsyncImage(
                            model = target.imageUrl, contentDescription = null,
                            contentScale = ContentScale.Crop, modifier = Modifier.size(64.dp),
                        )
                    }
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    if (!target.showTitle.isNullOrBlank()) {
                        Text(
                            text = target.showTitle.uppercase(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            letterSpacing = 0.6.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(
                        text = target.title,
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    )
                    if (target.meta.isNotBlank()) {
                        Text(
                            text = target.meta,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (target.actionLabel != null && target.onAction != null) {
                Spacer(Modifier.height(14.dp))
                Button(onClick = target.onAction, modifier = Modifier.fillMaxWidth()) { Text(target.actionLabel) }
            }
            Spacer(Modifier.height(18.dp))
            val n = notes
            when {
                n != null && n.isBlank() -> Text(
                    "This episode has no show notes.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                n != null -> {
                    val linkColor = MaterialTheme.colorScheme.primary
                    val text = remember(n, linkColor) {
                        AnnotatedString.fromHtml(
                            n,
                            linkStyles = TextLinkStyles(
                                style = SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)
                            ),
                        )
                    }
                    Text(text, style = MaterialTheme.typography.bodyLarge)
                }
                error != null -> Column(horizontalAlignment = Alignment.Start, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Couldn't load the show notes", style = MaterialTheme.typography.titleSmall)
                    Text(
                        error.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = { attempt++ }) { Text("Try again") }
                }
                else -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }
}
