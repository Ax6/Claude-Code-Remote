/**
 * Claude's Markdown, prepared for Telegram's rich message API.
 *
 * `sendRichMessage` takes a `markdown` field that is GitHub Flavored Markdown
 * where possible -- headings, lists, task lists, tables, fenced code with a
 * language, block quotations -- so almost nothing needs translating. What does
 * need handling is the sentence in the docs saying rich Markdown "can contain
 * arbitrary HTML": anything that looks like a tag is parsed as one and
 * disappears from the text.
 *
 * Verified against the API by reading back the parsed blocks it returns:
 *
 *   Vec<String>            -> "Vec"                (the tag is swallowed)
 *   <div>ciao</div>        -> "ciao"
 *   \<String\>             -> "\<String>"           (backslash is not an escape here)
 *   `Vec<String>`          -> "Vec<String>"         (code spans are safe)
 *   ```rust  Vec<String>   -> "Vec<String>"         (fences are safe)
 *   Vec&lt;String&gt;      -> "Vec<String>"         (entities are the escape)
 *
 * So: HTML-escape prose, leave code alone. `>` is deliberately left as it is,
 * because at the start of a line it is the block quotation marker; a bare `>`
 * cannot open a tag on its own, and `&lt;` already closes the hole.
 */

// Rich messages allow 32768 characters. Stay under it with room for a
// continuation marker rather than discovering the limit as a rejected send.
const RICH_LIMIT = 30000;

function escapeProse(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * A code span runs from a run of N backticks to the next run of exactly N.
 * Text between spans is escaped; the spans, and their backticks, are not.
 */
function escapeOutsideCodeSpans(line) {
    let result = '';
    let index = 0;

    while (index < line.length) {
        const open = line.indexOf('`', index);
        if (open === -1) {
            result += escapeProse(line.slice(index));
            break;
        }

        result += escapeProse(line.slice(index, open));

        let width = 0;
        while (line[open + width] === '`') width += 1;

        const close = findClosingRun(line, open + width, width);
        if (close === -1) {
            // Unterminated backticks are literal text, not a code span.
            result += line.slice(open, open + width);
            index = open + width;
            continue;
        }

        result += line.slice(open, close + width);
        index = close + width;
    }

    return result;
}

function findClosingRun(line, from, width) {
    let index = from;
    while (index < line.length) {
        if (line[index] !== '`') {
            index += 1;
            continue;
        }
        let run = 0;
        while (line[index + run] === '`') run += 1;
        if (run === width) return index;
        index += run;
    }
    return -1;
}

// Markdown folds a single newline into a space, which is right for a document
// and wrong for a chat: Claude writes short lines that mean lines. Two trailing
// spaces is GFM's hard break, confirmed against the API -- "a\nb" comes back as
// "a b", "a  \nb" comes back as "a\nb".
const HARD_BREAK = '  ';

// Rows and delimiters of a table, where trailing spaces are not a line break
// but a risk to the parse. Headings, fences and blank lines are already blocks
// of their own and need no help.
const TABLE_ROW = /^\s*\|/;
const HEADING = /^\s{0,3}#{1,6}\s/;

function needsHardBreak(line, next) {
    if (!line.trim() || next === undefined || !next.trim()) return false;
    if (line.endsWith(HARD_BREAK)) return false;
    if (TABLE_ROW.test(line) || TABLE_ROW.test(next)) return false;
    if (HEADING.test(line)) return false;
    return true;
}

function fenceAt(line) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    return match ? { marker: match[1][0], width: match[1].length, info: match[2].trim() } : null;
}

/**
 * @param {string} markdown Markdown as Claude wrote it.
 * @returns {string} the same Markdown with prose HTML-escaped.
 */
function toRichMarkdown(markdown) {
    const lines = String(markdown ?? '').split('\n');
    const output = [];
    let openFence = null;

    for (const [index, line] of lines.entries()) {
        const fence = fenceAt(line);

        if (openFence) {
            output.push(line);
            const closes = fence && fence.marker === openFence.marker &&
                fence.width >= openFence.width && !fence.info;
            if (closes) openFence = null;
            continue;
        }

        if (fence) {
            // The info string names a language; it is not prose.
            openFence = { marker: fence.marker, width: fence.width };
            output.push(line);
            continue;
        }

        const escaped = escapeOutsideCodeSpans(line);
        const next = lines[index + 1];
        const nextOpensFence = next !== undefined && Boolean(fenceAt(next));
        output.push(
            !nextOpensFence && needsHardBreak(escaped, next) ? escaped + HARD_BREAK : escaped
        );
    }

    return output.join('\n');
}

/**
 * Split prepared Markdown into sendable pieces.
 *
 * Splits between blocks, never inside a fence -- half a fence is a code block
 * that swallows the rest of the message. A single block over the limit is cut
 * bluntly, because there is nothing better to do with one enormous paragraph.
 */
function splitRichMarkdown(markdown, limit = RICH_LIMIT) {
    const text = String(markdown ?? '');
    if (text.length <= limit) return text.trim() ? [text] : [];

    const blocks = [];
    let current = [];
    let openFence = null;

    for (const line of text.split('\n')) {
        const fence = fenceAt(line);
        if (openFence) {
            current.push(line);
            if (fence && fence.marker === openFence.marker && fence.width >= openFence.width && !fence.info) {
                openFence = null;
            }
            continue;
        }
        if (fence) {
            openFence = { marker: fence.marker, width: fence.width };
            current.push(line);
            continue;
        }
        if (line.trim() === '') {
            blocks.push(current.join('\n'));
            current = [];
            continue;
        }
        current.push(line);
    }
    blocks.push(current.join('\n'));

    const chunks = [];
    let buffer = '';
    const flush = () => {
        if (buffer.trim()) chunks.push(buffer.replace(/\n+$/, ''));
        buffer = '';
    };

    for (const block of blocks) {
        if (block.length > limit) {
            flush();
            for (let start = 0; start < block.length; start += limit) {
                chunks.push(block.slice(start, start + limit));
            }
            continue;
        }
        if (buffer.length + block.length + 2 > limit) flush();
        buffer += buffer ? `\n\n${block}` : block;
    }
    flush();

    return chunks;
}

module.exports = { toRichMarkdown, splitRichMarkdown, RICH_LIMIT };
