package com.readlater.app.data

import org.jsoup.Jsoup
import org.jsoup.nodes.Element

/**
 * A displayable/speakable block of an article. The index of a block in the list
 * returned by [HtmlParser.parse] is the canonical paragraph index used by
 * readParagraph, highlight.paragraphIndex and TTS — the parse is deterministic.
 */
sealed class Block {
    /** [startSec]: where this paragraph starts in the episode audio, for a
     *  podcast transcript (the server's data-t attribute); null otherwise. */
    data class Paragraph(val text: String, val startSec: Double? = null) : Block()
    data class Heading(val text: String, val level: Int) : Block()
    data class Quote(val text: String) : Block()
    data class ImageBlock(val src: String, val alt: String?) : Block()
    /** A caption or photo credit belonging to an image: shown quietly, never spoken. */
    data class Caption(val text: String) : Block()
}

object HtmlParser {

    private val containerTags = setOf(
        "div", "section", "article", "main", "aside",
        "header", "footer", "nav", "ul", "ol", "figure", "details"
    )

    private val skippedTags = setOf("script", "style", "noscript", "template", "iframe")

    /**
     * Longest block still treated as a caption. Anything longer inside a figure
     * is real prose that happens to sit there, and stays a spoken paragraph.
     * Mirrored in server/tts.js (CAPTION_MAX).
     */
    const val CAPTION_MAX = 500

    /** Longest credit line ("Photograph: Jane Doe / Getty Images"). */
    const val CREDIT_MAX = 200

    /** class names that mark caption/credit wrappers (wp-caption-text, image-credit, figure__caption). */
    private val captionClass = Regex("""(^|[\s_-])(caption|credits?)([\s_-]|$)""", RegexOption.IGNORE_CASE)

    // Both mirrored verbatim in server/tts.js — keep them in step.
    private val creditLead = Regex(
        """^(photo(graph)?s?|image|illustration|artwork|picture|video|map|chart|graphic|credit|source|courtesy)\b\s*(by\b|:|credit\b|courtesy\b|of\b)""",
        RegexOption.IGNORE_CASE
    )
    private val creditTail = Regex(
        """(getty images|reuters|associated press|ap photo|shutterstock|alamy|afp|epa(-efe)?|bloomberg|pa images|nurphoto|redux|contributor)\s*[).]?$""",
        RegexOption.IGNORE_CASE
    )

    private val captionWrapTags = setOf("em", "i", "small", "cite")

    /**
     * Captions only ever change a block's TYPE (Paragraph -> Caption), never how
     * many blocks an element yields, so saved highlight/reading/TTS indices stay
     * valid for articles cached before this rule existed.
     */
    fun parse(html: String): List<Block> {
        val blocks = mutableListOf<Block>()
        val body = Jsoup.parse(html).body()
        walk(body, blocks, inCaption = false)
        return blocks
    }

    private fun isCaptionElement(el: Element): Boolean {
        val tag = el.tagName().lowercase()
        if (tag == "figcaption") return true
        if (tag == "figure") return el.selectFirst("img, picture, video") != null
        return captionClass.containsMatchIn(el.className())
    }

    private fun norm(s: String) = s.lowercase().replace(Regex("""\s+"""), " ").trim().trim('.', ' ')

    /** Is a whole block wrapped in one italic/small element — the usual look of a caption? */
    private fun isWrappedInline(el: Element): Boolean {
        val nodes = el.childNodes().filterNot { it is org.jsoup.nodes.TextNode && it.isBlank }
        val only = nodes.singleOrNull() as? Element ?: return false
        return only.tagName().lowercase() in captionWrapTags
    }

    fun isCredit(text: String): Boolean =
        text.length <= CREDIT_MAX && (creditLead.containsMatchIn(text) || creditTail.containsMatchIn(text))

    /**
     * A text block that directly follows an image, outside any figure (a flattened
     * extraction). Only claimed as a caption on positive evidence — a paragraph
     * after a picture is usually still the article.
     */
    private fun isLooseCaption(el: Element, text: String, prev: Block?): Boolean {
        if (text.length > CAPTION_MAX) return false
        return when (prev) {
            is Block.ImageBlock -> {
                val alt = prev.alt?.let(::norm).orEmpty()
                val t = norm(text)
                (alt.length >= 12 && t.length >= 12 && (t.contains(alt) || alt.contains(t))) ||
                    isCredit(text) ||
                    (text.length <= 300 && isWrappedInline(el))
            }
            // caption, then its credit on the next line
            is Block.Caption -> isCredit(text)
            else -> false
        }
    }

    private fun addText(blocks: MutableList<Block>, el: Element, text: String, inCaption: Boolean) {
        val caption = (inCaption && text.length <= CAPTION_MAX) || isLooseCaption(el, text, blocks.lastOrNull())
        blocks.add(
            if (caption) Block.Caption(text)
            else Block.Paragraph(text, el.attr("data-t").toDoubleOrNull()?.takeIf { it >= 0 })
        )
    }

    private fun walk(element: Element, blocks: MutableList<Block>, inCaption: Boolean) {
        for (child in element.children()) {
            val tag = child.tagName().lowercase()
            val caption = inCaption || isCaptionElement(child)
            when {
                tag.length == 2 && tag[0] == 'h' && tag[1] in '1'..'6' -> {
                    val text = child.text().trim()
                    if (text.isNotEmpty()) blocks.add(Block.Heading(text, tag[1] - '0'))
                }

                tag == "blockquote" -> {
                    val text = child.text().trim()
                    if (text.isNotEmpty()) blocks.add(Block.Quote(text))
                }

                tag == "img" -> {
                    val src = child.attr("src").trim()
                    if (src.isNotEmpty()) {
                        blocks.add(Block.ImageBlock(src, child.attr("alt").trim().ifEmpty { null }))
                    }
                }

                tag == "p" || tag == "li" || tag == "pre" -> {
                    val text = child.text().trim()
                    if (text.isNotEmpty()) {
                        addText(blocks, child, text, caption)
                    } else {
                        // e.g. a <p> that only wraps an <img>
                        walk(child, blocks, caption)
                    }
                }

                tag in containerTags -> walk(child, blocks, caption)

                tag in skippedTags -> Unit

                else -> {
                    // Any other text-bearing block (figcaption, tables, dl, custom tags, ...)
                    val text = child.text().trim()
                    if (text.isNotEmpty()) addText(blocks, child, text, caption)
                }
            }
        }
    }
}
