// ============================================================
// Pattern Parser for NFA Matcher (docs/2 parser.txt)
// Pipeline: patternStr → tokenize → parseSequence → optimizeAST → compileAST → Pattern
// ============================================================

// PatternElement: varId (0+=var, -1=#ALT, -2=#END, -3=#FIN)
class PatternElement {
    constructor(varId) {
        this.varId = varId;
        this.depth = 0;
        this.min = 1;
        this.max = 1;
        this.next = -1;
        this.jump = -1;
        this.reluctant = false;
    }
    isVar() { return this.varId >= 0; }
    isAltStart() { return this.varId === -1; }
    isGroupEnd() { return this.varId === -2; }
    isFinish() { return this.varId === -3; }
    canSkip() { return this.min === 0; }
}

class Pattern {
    constructor() {
        this.elements = [];
        this.variables = [];
        this.maxDepth = 0;
    }
}

// Main entry point
function parsePattern(patternStr, options) {
    if (!options) options = {};
    var tokens = tokenize(patternStr);
    var ast = parseSequence(tokens, { value: 0 }, []);
    if (options.optimize) ast = optimizeAST(ast);
    return compileAST(ast);
}

// Compile AST to Pattern
function compileAST(ast) {
    var pattern = new Pattern();
    var varIdMap = {};
    var varList = [];
    collectVariables(ast, varIdMap, varList);
    pattern.variables = varList;

    flattenAST(ast, pattern, 0, varIdMap);

    // Set up next pointers
    var finIdx = pattern.elements.length;
    for (var i = 0; i < pattern.elements.length; i++) {
        if (pattern.elements[i].next === -1) {
            pattern.elements[i].next = (i < pattern.elements.length - 1) ? i + 1 : finIdx;
        }
    }

    // Add #FIN
    var finElem = new PatternElement(-3);
    pattern.elements.push(finElem);

    // Calculate maxDepth and reluctant flag
    var maxD = 0, hasReluctant = false;
    for (var j = 0; j < pattern.elements.length; j++) {
        if (pattern.elements[j].depth > maxD) maxD = pattern.elements[j].depth;
        if (pattern.elements[j].reluctant) hasReluctant = true;
    }
    pattern.maxDepth = maxD;
    pattern.reluctant = hasReluctant;

    return pattern;
}

function collectVariables(node, varIdMap, varList) {
    if (!node) return;
    var i;
    if (node.type === 'VAR') {
        if (!(node.name in varIdMap)) {
            varIdMap[node.name] = varList.length;
            varList.push(node.name);
        }
    } else if (node.type === 'SEQ') {
        for (i = 0; i < node.items.length; i++) collectVariables(node.items[i], varIdMap, varList);
    } else if (node.type === 'GROUP') {
        collectVariables(node.content, varIdMap, varList);
    } else if (node.type === 'ALT') {
        for (i = 0; i < node.alternatives.length; i++) collectVariables(node.alternatives[i], varIdMap, varList);
    }
}

// Optimizer
function optimizeAST(node) {
    return optimizeQuantifiers(removeDuplicates(unwrapGroups(node)));
}

// Unwrap unnecessary groups
function unwrapGroups(node) {
    if (!node) return node;

    var i, item, alt;

    if (node.type === 'SEQ') {
        // Recursively optimize children first
        for (i = 0; i < node.items.length; i++) {
            node.items[i] = unwrapGroups(node.items[i]);
        }

        // Unwrap {1,1} groups in sequence
        var newItems = [];
        for (i = 0; i < node.items.length; i++) {
            item = node.items[i];
            if (item.type === 'GROUP' && item.min === 1 && item.max === 1) {
                // Remove GROUP{1,1} wrapper and flatten its content
                if (item.content.type === 'SEQ') {
                    for (var j = 0; j < item.content.items.length; j++) {
                        newItems.push(item.content.items[j]);
                    }
                } else {
                    newItems.push(item.content);
                }
            } else if (item.type === 'SEQ') {
                // Flatten SEQ within SEQ
                for (var k = 0; k < item.items.length; k++) {
                    newItems.push(item.items[k]);
                }
            } else {
                newItems.push(item);
            }
        }
        node.items = newItems;

        // Remove single-item SEQ wrapper
        if (node.items.length === 1) {
            return node.items[0];
        }
        return node;
    }

    if (node.type === 'GROUP') {
        node.content = unwrapGroups(node.content);

        // Remove {1,1} group wrapper
        if (node.min === 1 && node.max === 1) {
            return node.content;
        }
        return node;
    }

    if (node.type === 'ALT') {
        // Recursively optimize children first
        for (i = 0; i < node.alternatives.length; i++) {
            node.alternatives[i] = unwrapGroups(node.alternatives[i]);
        }

        // Flatten ALT within ALT
        var newAlts = [];
        for (i = 0; i < node.alternatives.length; i++) {
            alt = node.alternatives[i];
            if (alt.type === 'ALT') {
                for (var m = 0; m < alt.alternatives.length; m++) {
                    newAlts.push(alt.alternatives[m]);
                }
            } else {
                newAlts.push(alt);
            }
        }
        node.alternatives = newAlts;

        // Remove single-item ALT wrapper
        if (node.alternatives.length === 1) {
            return node.alternatives[0];
        }
        return node;
    }

    return node;
}

// Remove duplicate alternatives in ALT
function removeDuplicates(node) {
    if (!node) return node;

    var i, j;

    if (node.type === 'SEQ') {
        for (i = 0; i < node.items.length; i++) {
            node.items[i] = removeDuplicates(node.items[i]);
        }
        return node;
    }

    if (node.type === 'GROUP') {
        node.content = removeDuplicates(node.content);
        return node;
    }

    if (node.type === 'ALT') {
        for (i = 0; i < node.alternatives.length; i++) {
            node.alternatives[i] = removeDuplicates(node.alternatives[i]);
        }

        // Remove duplicates by comparing AST structure
        var unique = [];
        for (i = 0; i < node.alternatives.length; i++) {
            var alt = node.alternatives[i];
            var isDup = false;
            for (j = 0; j < unique.length; j++) {
                if (astEqual(unique[j], alt)) {
                    isDup = true;
                    break;
                }
            }
            if (!isDup) {
                unique.push(alt);
            }
        }

        node.alternatives = unique;

        if (node.alternatives.length === 1) {
            return node.alternatives[0];
        }
        return node;
    }

    return node;
}

// Optimize quantifiers: merge nested groups and consecutive vars
function optimizeQuantifiers(node) {
    if (!node) return node;

    var i, item, next, count, merged, innerNode, newMin, newMax;

    if (node.type === 'SEQ') {
        // Recursively optimize children first
        for (i = 0; i < node.items.length; i++) {
            node.items[i] = optimizeQuantifiers(node.items[i]);
        }

        // Merge consecutive identical VAR nodes
        var newItems = [];
        i = 0;
        while (i < node.items.length) {
            item = node.items[i];

            // Check if this is a VAR with {1,1}
            if (item.type === 'VAR' && item.min === 1 && item.max === 1) {
                // Count consecutive identical vars
                count = 1;
                while (i + count < node.items.length) {
                    next = node.items[i + count];
                    if (next.type === 'VAR' && next.name === item.name &&
                        next.min === 1 && next.max === 1) {
                        count++;
                    } else {
                        break;
                    }
                }

                // If we found consecutive identical vars, merge them
                if (count > 1) {
                    merged = {
                        type: item.type,
                        name: item.name,
                        min: count,
                        max: count,
                        reluctant: item.reluctant || false
                    };
                    newItems.push(merged);
                    i += count;
                } else {
                    newItems.push(item);
                    i++;
                }
            } else {
                newItems.push(item);
                i++;
            }
        }
        node.items = newItems;
        return node;
    }

    if (node.type === 'GROUP') {
        node.content = optimizeQuantifiers(node.content);

        // Extract inner node if content is SEQ with single item
        innerNode = null;
        if (node.content.type === 'VAR' || node.content.type === 'GROUP') {
            innerNode = node.content;
        } else if (node.content.type === 'SEQ' && node.content.items.length === 1) {
            innerNode = node.content.items[0];
        }

        // Merge nested quantified groups
        // Only safe when at least one quantifier is fixed (min === max)
        if (innerNode && (node.min === node.max || innerNode.min === innerNode.max)) {
            // Calculate new quantifiers
            newMin = innerNode.min * node.min;
            newMax = innerNode.max * node.max;

            if (innerNode.type === 'VAR') {
                // ((A{m,n}){p,q} → A{m*p, n*q}
                return {
                    type: 'VAR',
                    name: innerNode.name,
                    min: newMin,
                    max: newMax,
                    reluctant: innerNode.reluctant || false
                };
            } else if (innerNode.type === 'GROUP') {
                // ((content){m,n}){p,q} → (content){m*p, n*q}
                return {
                    type: 'GROUP',
                    content: innerNode.content,
                    min: newMin,
                    max: newMax,
                    reluctant: innerNode.reluctant || false
                };
            }
        }

        return node;
    }

    if (node.type === 'ALT') {
        for (i = 0; i < node.alternatives.length; i++) {
            node.alternatives[i] = optimizeQuantifiers(node.alternatives[i]);
        }
        return node;
    }

    return node;
}

// ============== Tokenizer ==============

function tokenize(str) {
    const tokens = [];
    let i = 0;
    let lastToken = null;  // Track previous token for validation

    while (i < str.length) {
        const c = str[i];
        if (c === ' ' || c === '\t') { i++; continue; }

        if (c === '(') {
            tokens.push({ type: 'LPAREN' });
            lastToken = 'LPAREN';
            i++;
        }
        else if (c === ')') {
            // Check for empty group or empty alternation
            if (lastToken === 'LPAREN') {
                throw new Error(`Syntax error at position ${i}: Empty group () is not allowed.`);
            }
            if (lastToken === 'ALT') {
                throw new Error(`Syntax error at position ${i}: Empty alternation before ) is not allowed.`);
            }
            tokens.push({ type: 'RPAREN' });
            lastToken = 'RPAREN';
            i++;
        }
        else if (c === '|') {
            // Check for starting with |, or consecutive ||, or quantifier before |
            if (lastToken === null) {
                throw new Error(`Syntax error at position ${i}: Pattern cannot start with |`);
            }
            if (lastToken === 'ALT') {
                throw new Error(`Syntax error at position ${i}: Empty alternation (consecutive ||) is not allowed.`);
            }
            if (lastToken === 'LPAREN') {
                throw new Error(`Syntax error at position ${i}: Alternation cannot immediately follow (`);
            }
            tokens.push({ type: 'ALT' });
            lastToken = 'ALT';
            i++;
        }
        else if (c === '?' || c === '*' || c === '+' || c === '{') {
            // Check if ? is a reluctant modifier for a previous quantifier
            if (c === '?' && lastToken === 'QUANT') {
                // Make the previous quantifier reluctant
                tokens[tokens.length - 1].reluctant = true;
                i++;
                continue;
            }

            // Quantifiers must follow VAR or RPAREN
            if (lastToken !== 'VAR' && lastToken !== 'RPAREN') {
                const quantDesc = c === '{' ? '{n,m}' : c;
                throw new Error(`Syntax error at position ${i}: Quantifier ${quantDesc} must follow a variable or group, not ${lastToken || 'start'}.`);
            }

            if (c === '?') {
                tokens.push({ type: 'QUANT', min: 0, max: 1, reluctant: false });
                lastToken = 'QUANT';
                i++;
            }
            else if (c === '*') {
                tokens.push({ type: 'QUANT', min: 0, max: Infinity, reluctant: false });
                lastToken = 'QUANT';
                i++;
            }
            else if (c === '+') {
                tokens.push({ type: 'QUANT', min: 1, max: Infinity, reluctant: false });
                lastToken = 'QUANT';
                i++;
            }
            else if (c === '{') {
                // Check for unsupported exclusion syntax {- -}
                if (str[i + 1] === '-') {
                    throw new Error(`Unsupported syntax at position ${i}: Exclusion {- -} is not supported. Use only basic quantifiers {n,m}.`);
                }
                let j = i + 1;
                while (j < str.length && str[j] !== '}') j++;
                if (j >= str.length) {
                    throw new Error(`Syntax error at position ${i}: Unclosed quantifier {, missing }.`);
                }
                const range = str.substring(i + 1, j);
                if (range.trim() === '') {
                    throw new Error(`Syntax error at position ${i}: Empty quantifier {} is not allowed. Use *, +, ?, or {n,m}.`);
                }
                const parts = range.split(',');
                if (parts.length > 2) {
                    throw new Error(`Syntax error at position ${i}: Invalid quantifier {${range}}, expected {n} or {n,m} format.`);
                }

                // Parse min value
                const minStr = parts[0].trim();
                let min;
                if (minStr === '' && parts.length > 1) {
                    // {,m} format - 0 to m
                    min = 0;
                } else {
                    min = parseInt(minStr);
                    if (isNaN(min)) {
                        throw new Error(`Syntax error at position ${i}: Invalid quantifier {${range}}, expected number.`);
                    }
                    if (min < 0) {
                        throw new Error(`Syntax error at position ${i}: Quantifier {${range}} must have non-negative values.`);
                    }
                }

                // Parse max value
                let max;
                if (parts.length > 1) {
                    const maxStr = parts[1].trim();
                    if (maxStr === '') {
                        // {n,} format - n or more
                        max = Infinity;
                    } else {
                        max = parseInt(maxStr);
                        if (isNaN(max)) {
                            throw new Error(`Syntax error at position ${i}: Invalid quantifier {${range}}, expected number for max.`);
                        }
                        if (max < 0) {
                            throw new Error(`Syntax error at position ${i}: Quantifier {${range}} must have non-negative values.`);
                        }
                        if (max === 0) {
                            throw new Error(`Syntax error at position ${i}: Quantifier {${range}} max value must be greater than 0.`);
                        }
                        if (min > max) {
                            throw new Error(`Syntax error at position ${i}: Quantifier {${range}} min (${min}) cannot exceed max (${max}).`);
                        }
                    }
                } else {
                    // {n} format - exactly n times
                    max = min;
                    if (min === 0) {
                        throw new Error(`Syntax error at position ${i}: Quantifier {0} is not allowed. Use * or ? instead.`);
                    }
                }

                // Check for reluctant modifier after {n,m}
                let reluctant = false;
                if (str[j + 1] === '?') {
                    reluctant = true;
                    j++;
                }
                tokens.push({ type: 'QUANT', min, max, reluctant });
                lastToken = 'QUANT';
                i = j + 1;
            }
        }
        else if (/[A-Za-z]/.test(c)) {
            let j = i;
            while (j < str.length && /[A-Za-z0-9_]/.test(str[j])) j++;
            const varName = str.substring(i, j);

            // Check for unsupported PERMUTE keyword
            if (varName.toUpperCase() === 'PERMUTE') {
                throw new Error(`Unsupported syntax at position ${i}: PERMUTE is not supported.`);
            }

            tokens.push({ type: 'VAR', name: varName });
            lastToken = 'VAR';
            i = j;
        }
        else if (c === '&') {
            throw new Error(`Unsupported syntax at position ${i}: AND operator (&) is not supported. Use DEFINE clause to combine conditions.`);
        }
        else if (c === '^' || c === '$') {
            throw new Error(`Unsupported syntax at position ${i}: Anchors (^ $) are not supported.`);
        }
        else {
            // Unknown character
            throw new Error(`Invalid character '${c}' at position ${i}`);
        }
    }

    // Final validation: check for trailing |
    if (lastToken === 'ALT') {
        throw new Error(`Syntax error: Pattern cannot end with |`);
    }

    // Check parentheses balance
    let parenCount = 0;
    for (const token of tokens) {
        if (token.type === 'LPAREN') parenCount++;
        if (token.type === 'RPAREN') parenCount--;
        if (parenCount < 0) {
            throw new Error(`Syntax error: Unmatched closing parenthesis )`);
        }
    }
    if (parenCount > 0) {
        throw new Error(`Syntax error: Unclosed parenthesis (, ${parenCount} unmatched.`);
    }

    return tokens;
}

// ============== AST Parser ==============

function extractQuantifier(tokens, pos) {
    var tok = tokens[pos.value];
    if (tok && tok.type === 'QUANT') {
        var min = tok.min;
        var max = tok.max;
        var reluctant = tok.reluctant || false;
        pos.value++;
        return { min: min, max: max, reluctant: reluctant };
    }
    return { min: 1, max: 1, reluctant: false };
}

// Add variable name to array (supports Set for test compatibility)
function addVariable(variables, name) {
    if (variables.add) { variables.add(name); return; }
    for (var i = 0; i < variables.length; i++) {
        if (variables[i] === name) return;
    }
    variables.push(name);
}

function parseItem(tokens, pos, variables) {
    var token = tokens[pos.value];
    var group, quant, nextTok;

    if (token.type === 'LPAREN') {
        pos.value++;
        group = parseSequence(tokens, pos, variables);
        nextTok = tokens[pos.value];
        if (nextTok && nextTok.type === 'RPAREN') pos.value++;
        quant = extractQuantifier(tokens, pos);
        return { type: 'GROUP', content: group, min: quant.min, max: quant.max, reluctant: quant.reluctant };
    }

    if (token.type === 'VAR') {
        addVariable(variables, token.name);
        pos.value++;
        quant = extractQuantifier(tokens, pos);
        return { type: 'VAR', name: token.name, min: quant.min, max: quant.max, reluctant: quant.reluctant };
    }

    throw new Error('Internal error: Unexpected token type \'' + token.type + '\' at position ' + pos.value);
}

function parseSequence(tokens, pos, variables) {
    var items = [];
    var token;

    while (pos.value < tokens.length) {
        token = tokens[pos.value];

        if (token.type === 'RPAREN') break;
        if (token.type === 'ALT') return handleAlternation(tokens, pos, items, variables);

        items.push(parseItem(tokens, pos, variables));
    }

    return { type: 'SEQ', items: items };
}

function handleAlternation(tokens, pos, currentItems, variables) {
    // Copy currentItems to first alternative
    var firstAltItems = [];
    for (var k = 0; k < currentItems.length; k++) {
        firstAltItems.push(currentItems[k]);
    }
    var alternatives = [{ type: 'SEQ', items: firstAltItems }];
    pos.value++; // skip '|'

    var altItems, t, nextTok;
    while (pos.value < tokens.length) {
        altItems = [];

        while (pos.value < tokens.length) {
            t = tokens[pos.value];
            if (t.type === 'RPAREN' || t.type === 'ALT') break;
            altItems.push(parseItem(tokens, pos, variables));
        }

        alternatives.push({ type: 'SEQ', items: altItems });

        nextTok = tokens[pos.value];
        if (nextTok && nextTok.type === 'ALT') {
            pos.value++;
        } else {
            break;
        }
    }

    return { type: 'ALT', alternatives: alternatives };
}

// ============== AST Utilities ==============

// AST node equality comparison
function astEqual(a, b) {
    if (a.type !== b.type) return false;
    if (a.min !== b.min || a.max !== b.max) return false;
    if ((a.reluctant || false) !== (b.reluctant || false)) return false;

    var i;
    if (a.type === 'VAR') {
        return a.name === b.name;
    }
    if (a.type === 'GROUP') {
        return astEqual(a.content, b.content);
    }
    if (a.type === 'SEQ') {
        if (a.items.length !== b.items.length) return false;
        for (i = 0; i < a.items.length; i++) {
            if (!astEqual(a.items[i], b.items[i])) return false;
        }
        return true;
    }
    if (a.type === 'ALT') {
        if (a.alternatives.length !== b.alternatives.length) return false;
        for (i = 0; i < a.alternatives.length; i++) {
            if (!astEqual(a.alternatives[i], b.alternatives[i])) return false;
        }
        return true;
    }
    return false;
}

// Format quantifier suffix
function quantStr(min, max, reluctant) {
    var inf = (max === null || max === Infinity);
    var r = reluctant ? '?' : '';
    if (min === 1 && max === 1) return '';
    if (min === 0 && max === 1) return '?' + r;
    if (min === 0 && inf) return '*' + r;
    if (min === 1 && inf) return '+' + r;
    if (min === max) return '{' + min + '}' + r;
    if (inf) return '{' + min + ',}' + r;
    return '{' + min + ',' + max + '}' + r;
}

// Convert AST back to pattern string
function astToString(node, parentType) {
    if (!node) return '';
    if (parentType === undefined) parentType = null;

    var i, parts, inner, altStr;

    if (node.type === 'SEQ') {
        parts = [];
        for (i = 0; i < node.items.length; i++) {
            parts.push(astToString(node.items[i], 'SEQ'));
        }
        return parts.join(' ');
    }

    if (node.type === 'VAR') {
        return node.name + quantStr(node.min, node.max, node.reluctant);
    }

    if (node.type === 'GROUP') {
        inner = astToString(node.content, 'GROUP');
        return '( ' + inner + ' )' + quantStr(node.min, node.max, node.reluctant);
    }

    if (node.type === 'ALT') {
        parts = [];
        for (i = 0; i < node.alternatives.length; i++) {
            parts.push(astToString(node.alternatives[i], 'ALT'));
        }
        altStr = parts.join(' | ');
        // Wrap in parentheses if inside SEQ to preserve precedence
        if (parentType === 'SEQ') {
            return '( ' + altStr + ' )';
        }
        return altStr;
    }

    return '';
}

// ============== AST Flattener ==============

function flattenAST(node, pattern, depth, varIdMap) {
    if (!node) return;

    var i, varId, elem, groupStartIdx, groupEnd;
    var altStart, altBranchStarts, altEndPositions, alt, altBranchStart;
    var firstElemIdx, nextAltStart, afterAltIdx, endPos;

    if (node.type === 'SEQ') {
        for (i = 0; i < node.items.length; i++) {
            flattenAST(node.items[i], pattern, depth, varIdMap);
        }
    } else if (node.type === 'VAR') {
        varId = varIdMap[node.name];
        elem = new PatternElement(varId);
        elem.min = node.min;
        elem.max = node.max;
        elem.depth = depth;
        elem.reluctant = node.reluctant || false;
        pattern.elements.push(elem);
    } else if (node.type === 'GROUP') {
        groupStartIdx = pattern.elements.length;

        // Flatten group content
        flattenAST(node.content, pattern, depth + 1, varIdMap);

        // Add group end marker only if this group has quantifier other than {1,1}
        if (node.min !== 1 || node.max !== 1) {
            groupEnd = new PatternElement(-2);  // -2 = #END
            // GROUP_END uses parent depth for counting group iterations
            groupEnd.depth = depth;
            groupEnd.min = node.min;
            groupEnd.max = node.max;
            groupEnd.jump = groupStartIdx;
            groupEnd.reluctant = node.reluctant || false;
            pattern.elements.push(groupEnd);
        }
    } else if (node.type === 'ALT') {
        // ALT_START.next points to first alternative start
        altStart = new PatternElement(-1);  // -1 = #ALT
        altStart.depth = depth;
        pattern.elements.push(altStart);

        altBranchStarts = [];  // Start index of each alternative
        altEndPositions = [];  // End index of each alternative

        for (i = 0; i < node.alternatives.length; i++) {
            alt = node.alternatives[i];
            if (!alt) continue;

            altBranchStart = pattern.elements.length;
            altBranchStarts.push(altBranchStart);

            flattenAST(alt, pattern, depth + 1, varIdMap);

            // Mark where this alternative ends
            if (pattern.elements.length > altBranchStart) {
                altEndPositions.push(pattern.elements.length - 1);
            }
        }

        // ALT_START.next = first alternative start
        if (altBranchStarts.length > 0) {
            altStart.next = altBranchStarts[0];
        }

        // Set jump on first element of each alternative (to next alternative start)
        for (i = 0; i < altBranchStarts.length - 1; i++) {
            firstElemIdx = altBranchStarts[i];
            nextAltStart = altBranchStarts[i + 1];
            pattern.elements[firstElemIdx].jump = nextAltStart;
        }
        // Last alternative's first element has jump = -1 (already default)

        // All alternatives should point to the element after the alternation
        // If no next element, use -1 (pattern end)
        afterAltIdx = pattern.elements.length;
        for (i = 0; i < altEndPositions.length; i++) {
            endPos = altEndPositions[i];
            if (pattern.elements[endPos] && pattern.elements[endPos].next === -1) {
                pattern.elements[endPos].next = afterAltIdx;
            }
        }
    }
}

// ============== Exports ==============

// Export for use in browser environment
if (typeof window !== 'undefined') {
    // Public API
    window.PatternElement = PatternElement;
    window.Pattern = Pattern;
    window.parsePattern = parsePattern;
    window.compileAST = compileAST;
    window.optimizeAST = optimizeAST;
    window.unwrapGroups = unwrapGroups;
    window.removeDuplicates = removeDuplicates;
    window.optimizeQuantifiers = optimizeQuantifiers;
    // Internal (for testing)
    window.tokenize = tokenize;
    window.parseSequence = parseSequence;
    window.astEqual = astEqual;
    window.astToString = astToString;
    window.flattenAST = flattenAST;
}

// Export for Node.js environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // Public API (pipeline order)
        PatternElement,
        Pattern,
        parsePattern,
        compileAST,
        optimizeAST,
        unwrapGroups,
        removeDuplicates,
        optimizeQuantifiers,
        // Internal functions (pipeline order)
        tokenize,
        parseSequence,
        astEqual,
        astToString,
        flattenAST
    };
}
