// ============================================================
// Pattern Parser for NFA Matcher
// ============================================================
//
// Code organization:
//   1. Public API (pipeline order)
//   2. Internal functions (pipeline order)
//
// Pipeline: patternStr → tokenize → parseSequence → optimizeAST → compileAST → Pattern
// ============================================================

// ============== Public API ==============

// ------ Data Structures ------

/*
 * PatternElement: Each element in the flattened pattern array
 *
 * varId conventions:
 *   - Normal variable: 0, 1, 2, ... (index into Pattern.variables)
 *   - ALT_START: -1
 *   - GROUP_END: -2
 *   - PATTERN_END: -3
 */
class PatternElement {
    constructor(varId) {
        this.varId = varId;         // Variable ID (0+ for vars, negative for special)
        this.depth = 0;             // Nesting depth
        this.min = 1;               // Minimum repetitions
        this.max = 1;               // Maximum repetitions (Infinity for *)
        this.next = -1;             // Next element index (-1 = end)
        this.jump = -1;             // GROUP_END: loop back / VAR in ALT: next alternative
        this.reluctant = false;     // Reluctant quantifier (minimal matching)
    }

    // Helper methods to check element type
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

// ------ Main Entry Point ------

/*
 * Main parsePattern function
 * Parses and compiles in one step, with optional optimization
 */
function parsePattern(patternStr, options = {}) {
    const { optimize = false } = options;

    // Tokenize and parse to AST
    const variables = new Set();
    const tokens = tokenize(patternStr);
    let pos = { value: 0 };
    let ast = parseSequence(tokens, pos, variables);

    // Optional optimization
    if (optimize) {
        ast = optimizeAST(ast);
    }

    // Compile to Pattern
    return compileAST(ast);
}

// ------ Compiler ------

/*
 * Compile AST to Pattern (flat element array)
 */
function compileAST(ast) {
    const pattern = new Pattern();

    // Build variable name to ID map first (by order of appearance in AST)
    const varIdMap = new Map();
    collectVariables(ast, varIdMap);
    pattern.variables = Array.from(varIdMap.keys());

    // Flatten AST to elements array (now with varId)
    flattenAST(ast, pattern, 0, varIdMap);

    // Set up next pointers (temporarily pointing to finIdx placeholder)
    const finIdx = pattern.elements.length;  // #FIN will be at this index
    for (let i = 0; i < pattern.elements.length; i++) {
        if (pattern.elements[i].next === -1) {
            pattern.elements[i].next = (i < pattern.elements.length - 1) ? i + 1 : finIdx;
        }
    }

    // Add #FIN element at the end
    const finElem = new PatternElement(-3);  // -3 = #FIN
    finElem.depth = 0;
    finElem.min = 1;
    finElem.max = 1;
    finElem.next = -1;  // End of pattern
    pattern.elements.push(finElem);

    // Calculate max depth
    pattern.maxDepth = Math.max(...pattern.elements.map(e => e.depth), 0);

    return pattern;
}

/*
 * Collect variable names from AST in order of appearance
 */
function collectVariables(node, varIdMap) {
    if (!node) return;

    if (node.type === 'VAR') {
        if (!varIdMap.has(node.name)) {
            varIdMap.set(node.name, varIdMap.size);
        }
    } else if (node.type === 'SEQ') {
        for (const item of node.items) {
            collectVariables(item, varIdMap);
        }
    } else if (node.type === 'GROUP') {
        collectVariables(node.content, varIdMap);
    } else if (node.type === 'ALT') {
        for (const alt of node.alternatives) {
            collectVariables(alt, varIdMap);
        }
    }
}

// ------ Optimizer ------

/*
 * Apply all optimizations in recommended order
 */
function optimizeAST(node) {
    node = unwrapGroups(node);
    node = removeDuplicates(node);
    node = optimizeQuantifiers(node);
    return node;
}

/*
 * 1. Unwrap unnecessary grouping structures
 * - Removes {1,1} groups
 * - Removes single-item wrappers (SEQ(A) → A, ALT(A) → A)
 * - Flattens nested SEQ/ALT structures
 */
function unwrapGroups(node) {
    if (!node) return node;

    if (node.type === 'SEQ') {
        // Recursively optimize children first
        node.items = node.items.map(unwrapGroups);

        // Unwrap {1,1} groups in sequence
        const newItems = [];
        for (const item of node.items) {
            if (item.type === 'GROUP' && item.min === 1 && item.max === 1) {
                // Remove GROUP{1,1} wrapper and flatten its content
                if (item.content.type === 'SEQ') {
                    newItems.push(...item.content.items);
                } else {
                    newItems.push(item.content);
                }
            } else if (item.type === 'SEQ') {
                // Flatten SEQ within SEQ
                newItems.push(...item.items);
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
        node.alternatives = node.alternatives.map(unwrapGroups);

        // Flatten ALT within ALT
        const newAlts = [];
        for (const alt of node.alternatives) {
            if (alt.type === 'ALT') {
                newAlts.push(...alt.alternatives);
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

/*
 * 2. Remove duplicate alternatives in ALT
 */
function removeDuplicates(node) {
    if (!node) return node;

    if (node.type === 'SEQ') {
        node.items = node.items.map(removeDuplicates);
        return node;
    }

    if (node.type === 'GROUP') {
        node.content = removeDuplicates(node.content);
        return node;
    }

    if (node.type === 'ALT') {
        node.alternatives = node.alternatives.map(removeDuplicates);

        // Remove duplicates by comparing AST structure
        const unique = [];
        for (const alt of node.alternatives) {
            const isDup = unique.some(u => astEqual(u, alt));
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

/*
 * 3. Optimize quantifiers
 * - Merges nested quantified groups when safe: (A{m,n}){p,q} → A{m*p, n*q} (when at least one is fixed)
 * - Merges consecutive identical variables: A A A → A{3,3}
 */
function optimizeQuantifiers(node) {
    if (!node) return node;

    if (node.type === 'SEQ') {
        // Recursively optimize children first
        node.items = node.items.map(optimizeQuantifiers);

        // Merge consecutive identical VAR nodes
        const newItems = [];
        let i = 0;
        while (i < node.items.length) {
            const item = node.items[i];

            // Check if this is a VAR with {1,1}
            if (item.type === 'VAR' && item.min === 1 && item.max === 1) {
                // Count consecutive identical vars
                let count = 1;
                while (i + count < node.items.length) {
                    const next = node.items[i + count];
                    if (next.type === 'VAR' && next.name === item.name &&
                        next.min === 1 && next.max === 1) {
                        count++;
                    } else {
                        break;
                    }
                }

                // If we found consecutive identical vars, merge them
                if (count > 1) {
                    const merged = { ...item };
                    merged.min = count;
                    merged.max = count;
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
        let innerNode = null;
        if (node.content.type === 'VAR' || node.content.type === 'GROUP') {
            innerNode = node.content;
        } else if (node.content.type === 'SEQ' && node.content.items.length === 1) {
            innerNode = node.content.items[0];
        }

        // Merge nested quantified groups
        // Only safe when at least one quantifier is fixed (min === max)
        if (innerNode && (node.min === node.max || innerNode.min === innerNode.max)) {
            // Calculate new quantifiers
            const newMin = innerNode.min * node.min;
            const newMax = innerNode.max * node.max;

            if (innerNode.type === 'VAR') {
                // ((A{m,n}){p,q} → A{m*p, n*q}
                return {
                    type: 'VAR',
                    name: innerNode.name,
                    min: newMin,
                    max: newMax
                };
            } else if (innerNode.type === 'GROUP') {
                // ((content){m,n}){p,q} → (content){m*p, n*q}
                return {
                    type: 'GROUP',
                    content: innerNode.content,
                    min: newMin,
                    max: newMax
                };
            }
        }

        return node;
    }

    if (node.type === 'ALT') {
        node.alternatives = node.alternatives.map(optimizeQuantifiers);
        return node;
    }

    return node;
}

// ============== Internal Functions ==============

// ------ Tokenizer ------

/*
 * Supported pattern syntax (subset of SQL RPR standard):
 *   - Variables: A-Z, a-z (can include digits and underscore)
 *   - Grouping: ( )
 *   - Alternation: |
 *   - Quantifiers: ? * + {n,m}
 *
 * NOT supported (will throw error):
 *   - AND operator: & (use DEFINE clause for condition combination)
 *   - Anchors: ^ $ (partition boundaries)
 *   - Exclusion: {- -} (output exclusion)
 *   - PERMUTE: PERMUTE(A,B,C) (all permutations)
 */
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

// ------ AST Parser ------

function extractQuantifier(tokens, pos) {
    if (tokens[pos.value]?.type === 'QUANT') {
        const { min, max, reluctant } = tokens[pos.value];
        pos.value++;
        return { min, max, reluctant: reluctant || false };
    }
    return { min: 1, max: 1, reluctant: false };
}

function parseItem(tokens, pos, variables) {
    const token = tokens[pos.value];

    if (token.type === 'LPAREN') {
        pos.value++;
        const group = parseSequence(tokens, pos, variables);
        if (tokens[pos.value]?.type === 'RPAREN') pos.value++;
        const { min, max, reluctant } = extractQuantifier(tokens, pos);
        return { type: 'GROUP', content: group, min, max, reluctant };
    }

    if (token.type === 'VAR') {
        variables.add(token.name);
        pos.value++;
        const { min, max, reluctant } = extractQuantifier(tokens, pos);
        return { type: 'VAR', name: token.name, min, max, reluctant };
    }

    throw new Error(`Internal error: Unexpected token type '${token.type}' at position ${pos.value}`);
}

function parseSequence(tokens, pos, variables) {
    const items = [];

    while (pos.value < tokens.length) {
        const token = tokens[pos.value];

        if (token.type === 'RPAREN') break;
        if (token.type === 'ALT') return handleAlternation(tokens, pos, items, variables);

        items.push(parseItem(tokens, pos, variables));
    }

    return { type: 'SEQ', items };
}

function handleAlternation(tokens, pos, currentItems, variables) {
    const alternatives = [{ type: 'SEQ', items: [...currentItems] }];
    pos.value++; // skip '|'

    while (pos.value < tokens.length) {
        const altItems = [];

        while (pos.value < tokens.length) {
            const t = tokens[pos.value];
            if (t.type === 'RPAREN' || t.type === 'ALT') break;
            altItems.push(parseItem(tokens, pos, variables));
        }

        alternatives.push({ type: 'SEQ', items: altItems });

        if (tokens[pos.value]?.type === 'ALT') {
            pos.value++;
        } else {
            break;
        }
    }

    return { type: 'ALT', alternatives };
}

// ------ AST Utilities ------

/*
 * AST node equality comparison (for duplicate detection)
 */
function astEqual(a, b) {
    if (a.type !== b.type) return false;
    if (a.min !== b.min || a.max !== b.max) return false;
    if ((a.reluctant || false) !== (b.reluctant || false)) return false;

    switch (a.type) {
        case 'VAR':
            return a.name === b.name;
        case 'GROUP':
            return astEqual(a.content, b.content);
        case 'SEQ':
            if (a.items.length !== b.items.length) return false;
            for (let i = 0; i < a.items.length; i++) {
                if (!astEqual(a.items[i], b.items[i])) return false;
            }
            return true;
        case 'ALT':
            if (a.alternatives.length !== b.alternatives.length) return false;
            for (let i = 0; i < a.alternatives.length; i++) {
                if (!astEqual(a.alternatives[i], b.alternatives[i])) return false;
            }
            return true;
    }
    return false;
}

/*
 * Convert AST back to pattern string
 * parentType: parent node type for determining if parentheses are needed
 */
function astToString(node, parentType = null) {
    if (!node) return '';

    // Format quantifier suffix
    function quantStr(min, max, reluctant) {
        const inf = (max === null || max === Infinity);
        const r = reluctant ? '?' : '';
        if (min === 1 && max === 1) return '';
        if (min === 0 && max === 1) return '?' + r;
        if (min === 0 && inf) return '*' + r;
        if (min === 1 && inf) return '+' + r;
        if (min === max) return `{${min}}` + r;
        if (inf) return `{${min},}` + r;
        return `{${min},${max}}` + r;
    }

    if (node.type === 'SEQ') {
        return node.items.map(item => astToString(item, 'SEQ')).join(' ');
    }

    if (node.type === 'VAR') {
        return node.name + quantStr(node.min, node.max, node.reluctant);
    }

    if (node.type === 'GROUP') {
        const inner = astToString(node.content, 'GROUP');
        return '( ' + inner + ' )' + quantStr(node.min, node.max, node.reluctant);
    }

    if (node.type === 'ALT') {
        const altStr = node.alternatives.map(alt => astToString(alt, 'ALT')).join(' | ');
        // Wrap in parentheses if inside SEQ to preserve precedence
        if (parentType === 'SEQ') {
            return '( ' + altStr + ' )';
        }
        return altStr;
    }

    return '';
}

// ------ AST Flattener ------

function flattenAST(node, pattern, depth, varIdMap) {
    if (!node) return;

    if (node.type === 'SEQ') {
        for (const item of node.items) {
            flattenAST(item, pattern, depth, varIdMap);
        }
    } else if (node.type === 'VAR') {
        const varId = varIdMap.get(node.name);
        const elem = new PatternElement(varId);
        elem.min = node.min;
        elem.max = node.max;
        elem.depth = depth;
        elem.reluctant = node.reluctant || false;
        pattern.elements.push(elem);
    } else if (node.type === 'GROUP') {
        const groupStartIdx = pattern.elements.length;

        // Flatten group content
        flattenAST(node.content, pattern, depth + 1, varIdMap);

        // Add group end marker only if this group has quantifier other than {1,1}
        if (node.min !== 1 || node.max !== 1) {
            const groupEnd = new PatternElement(-2);  // -2 = #END
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
        const altStart = new PatternElement(-1);  // -1 = #ALT
        altStart.depth = depth;
        pattern.elements.push(altStart);

        const altBranchStarts = [];  // Start index of each alternative
        const altEndPositions = [];  // End index of each alternative

        for (let i = 0; i < node.alternatives.length; i++) {
            const alt = node.alternatives[i];
            if (!alt) continue;

            const altBranchStart = pattern.elements.length;
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
        for (let i = 0; i < altBranchStarts.length - 1; i++) {
            const firstElemIdx = altBranchStarts[i];
            const nextAltStart = altBranchStarts[i + 1];
            pattern.elements[firstElemIdx].jump = nextAltStart;
        }
        // Last alternative's first element has jump = -1 (already default)

        // All alternatives should point to the element after the alternation
        // If no next element, use -1 (pattern end)
        const afterAltIdx = pattern.elements.length;
        for (const endPos of altEndPositions) {
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
