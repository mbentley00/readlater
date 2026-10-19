package com.readlater.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.DownloadDone
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.readlater.app.data.PodcastShow
import com.readlater.app.data.WaitingEpisode

/**
 * The Podcasts tab's three lists, Pocket Casts-style:
 *  - NEW: episodes a show published that are not processed yet (only shows
 *    with auto-processing off have any). Process or archive them here.
 *  - PROCESSED: episodes transcribed on the server, ready to read or play.
 *  - DOWNLOADED: the processed ones whose audio is on this phone.
 */
enum class PodcastList(val label: String) {
    NEW("New"),
    PROCESSED("Processed"),
    DOWNLOADED("Downloaded"),
}

/** How a processed episode stands, shown on its card. */
data class EpisodeBadge(
    /** Still being transcribed on the server. */
    val transcribing: Boolean,
    /** Its audio is stored on this phone. */
    val downloaded: Boolean,
    /** A download to the phone is under way. */
    val downloading: Boolean,
)

/** "1h 30m" / "42m" / "" (unknown). */
fun formatEpisodeDuration(seconds: Int?): String {
    if (seconds == null || seconds <= 0) return ""
    val m = (seconds + 30) / 60
    return if (m >= 60) "${m / 60}h ${m % 60}m" else "${m}m"
}

/**
 * A row of show artwork to filter the tab by one show; "All" first. Each
 * tile carries a count of that show's new (unprocessed) episodes.
 */
@Composable
fun ShowStrip(
    shows: List<PodcastShow>,
    newCounts: Map<String, Int>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ShowTile(title = "All", imageUrl = null, newCount = 0, selected = selectedId == null) { onSelect(null) }
        shows.forEach { s ->
            ShowTile(
                title = s.title,
                imageUrl = s.imageUrl,
                newCount = newCounts[s.id] ?: 0,
                selected = selectedId == s.id,
            ) { onSelect(if (selectedId == s.id) null else s.id) }
        }
    }
}

@Composable
private fun ShowTile(
    title: String,
    imageUrl: String?,
    newCount: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.width(68.dp).clickable(onClick = onClick),
    ) {
        Box {
            val frame = Modifier
                .size(64.dp)
                .clip(shape)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .border(
                    width = if (selected) 3.dp else 0.dp,
                    color = if (selected) MaterialTheme.colorScheme.primary else Color.Transparent,
                    shape = shape,
                )
            if (imageUrl != null) {
                coil.compose.AsyncImage(
                    model = imageUrl,
                    contentDescription = title,
                    contentScale = ContentScale.Crop,
                    modifier = frame,
                )
            } else {
                Box(frame, contentAlignment = Alignment.Center) {
                    Text(
                        text = if (title == "All") "All" else title.take(2).uppercase(),
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (newCount > 0) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(3.dp)
                        .size(20.dp)
                        .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(10.dp)),
                ) {
                    Text(
                        text = if (newCount > 99) "99+" else newCount.toString(),
                        color = MaterialTheme.colorScheme.onPrimary,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
        Spacer(Modifier.height(3.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

/** An episode in the New list: not processed. Process it, or archive it. */
@Composable
fun WaitingEpisodeRow(
    ep: WaitingEpisode,
    show: PodcastShow?,
    busy: Boolean,
    onProcess: () -> Unit,
    onArchive: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
    ) {
        val art = ep.imageUrl ?: show?.imageUrl
        Box(
            Modifier.size(56.dp).clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            if (art != null) {
                coil.compose.AsyncImage(
                    model = art, contentDescription = null,
                    contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp),
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = (show?.title ?: "").uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                letterSpacing = 0.6.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = ep.title,
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            val meta = listOf(
                ep.publishedAt?.let { relativeDay(it) }.orEmpty(),
                formatEpisodeDuration(ep.durationS),
                if (busy) "Processing…" else "Not processed",
            ).filter { it.isNotBlank() }.joinToString(" · ")
            Text(
                text = meta,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (busy) {
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            }
        } else {
            IconButton(onClick = onProcess) {
                Icon(
                    Icons.Filled.CloudDownload,
                    contentDescription = "Process (download and transcribe)",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
        IconButton(onClick = onArchive, enabled = !busy) {
            Icon(Icons.Filled.Archive, contentDescription = "Archive", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** "Transcribed · Downloaded" with icons, on a processed episode's card. */
@Composable
fun EpisodeBadgeRow(badge: EpisodeBadge) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (badge.transcribing) {
            BadgeLabel(Icons.Filled.HourglassTop, "Transcribing…", MaterialTheme.colorScheme.tertiary)
        } else {
            BadgeLabel(Icons.Filled.CheckCircle, "Processed", MaterialTheme.colorScheme.primary)
        }
        when {
            badge.downloading -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                Spacer(Modifier.width(4.dp))
                Text("Downloading…", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            badge.downloaded -> BadgeLabel(Icons.Filled.DownloadDone, "Downloaded", MaterialTheme.colorScheme.primary)
            else -> BadgeLabel(Icons.Filled.PhoneAndroid, "Not on phone", MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun BadgeLabel(icon: ImageVector, text: String, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(4.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = tint)
    }
}

/** "Today" / "Yesterday" / "Oct 12" / "Oct 12, 2024". */
private fun relativeDay(ms: Long): String {
    val now = java.util.Calendar.getInstance()
    val then = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    val sameYear = now.get(java.util.Calendar.YEAR) == then.get(java.util.Calendar.YEAR)
    val days = now.get(java.util.Calendar.DAY_OF_YEAR) - then.get(java.util.Calendar.DAY_OF_YEAR)
    return when {
        sameYear && days == 0 -> "Today"
        sameYear && days == 1 -> "Yesterday"
        sameYear -> java.text.SimpleDateFormat("MMM d", java.util.Locale.US).format(java.util.Date(ms))
        else -> java.text.SimpleDateFormat("MMM d, yyyy", java.util.Locale.US).format(java.util.Date(ms))
    }
}
