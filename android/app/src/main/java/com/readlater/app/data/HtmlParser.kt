package com.readlater.app.data

import org.jsoup.Jsoup
import org.jsoup.nodes.Element

/**
 * A displayable/speakable block of an article. The index of a block in the list
 * returned by [HtmlParser.parse] is the canonical paragraph index used by
 * readParagraph, highlight.paragraphIndex and TTS — the parse is deterministic.
 */
sealed class Block {
    data class Paragraph(val text: String) : Block()
    data class Heading(val text: String, val level: Int) : Block()
    data class Quote(val text: String) : Block()
    data class ImageBlock(val src: String, val alt: String?) : Block()
}

object HtmlParser {

    private val containerTags = setOf(
        "div", "section", "article", "main", "aside",
        "header", "footer", "nav", "ul", "ol", "figure", "details"
    )

    private val skippedTags = setOf("script", "style", "noscript", "template", "iframe")

    fun parse(html: String): List<Block> {
        val blocks = mutableListOf<Block>()
        val body = Jsoup.parse(html).body()
        walk(body, blocks)
        return blocks
    }

    private fun walk(element: Element, blocks: MutableList<Block>) {
        for (child in element.children()) {
            val tag = child.tagName().lowercase()
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
                        blocks.add(Block.Paragraph(text))
                    } else {
                        // e.g. a <p> that only wraps an <img>
                        walk(child, blocks)
                    }
                }

                tag in containerTags -> walk(child, blocks)

                tag in skippedTags -> Unit

                else -> {
                    // Any other text-bearing block (tables, dl, custom tags, ...)
                    val text = child.text().trim()
                    if (text.isNotEmpty()) blocks.add(Block.Paragraph(text))
                }
            }
        }
    }
}
