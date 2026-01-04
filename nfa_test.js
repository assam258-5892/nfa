/**
 * NFA Simulator Test Script
 * Tests examples from RPR_NFA_CONCEPT.md document
 */

// Import NFA classes from nfa.js
const {
    PatternElement,
    Pattern,
    MatchState,
    MatchContext,
    NFAExecutor,
    parsePattern,
} = require('./nfa.js');

// Import parser functions for optimization comparison
const {
    tokenize,
    parseSequence,
    optimizeAST,
    astToString
} = require('./parser.js');

// ============== Test Cases ==============

function getVarName(pattern, varId) {
    if (varId === -1) return '#ALT';
    if (varId === -2) return '#END';
    if (varId === -3) return '#FIN';
    if (varId >= 0 && varId < pattern.variables.length) {
        return pattern.variables[varId];
    }
    return '-';
}

function pathToString(pattern, path) {
    if (!path || path.length === 0) return '∅';
    return path.map(varId => pattern.variables[varId] || varId).join(' ');
}

function printPattern(pattern) {
    console.log(`\nVariables: ${pattern.variables.join(', ')}  |  MaxDepth: ${pattern.maxDepth}`);
    console.log('\nPattern Elements:');
    console.log(' idx | var  | depth | min | max | next | jump');
    console.log('-----+------+-------+-----+-----+------+------');
    for (let i = 0; i < pattern.elements.length; i++) {
        const e = pattern.elements[i];
        const varName = getVarName(pattern, e.varId);
        const maxStr = e.max === Infinity ? '∞' : e.max;
        const idxStr = i.toString().padStart(2, ' ');
        const nextStr = e.next >= 0 ? e.next.toString().padStart(2, ' ') : ' -';
        const jumpStr = e.jump >= 0 ? e.jump.toString().padStart(2, ' ') : ' -';
        console.log(
            `[${idxStr}] | ${varName.padEnd(4)} | ${e.depth}     | ${e.min}   | ${maxStr.toString().padEnd(3)} | ${nextStr}   | ${jumpStr}`
        );
    }
}

function getOptimizedPattern(patternStr) {
    const variables = new Set();
    const tokens = tokenize(patternStr);
    let pos = { value: 0 };
    let ast = parseSequence(tokens, pos, variables);
    const optimized = optimizeAST(ast);
    return astToString(optimized);
}

function runTest(name, patternStr, inputs, expectedMatch, verbose = false) {
    console.log('\n' + '='.repeat(60));
    console.log(`TEST: ${name}`);
    console.log(`Pattern:   ${patternStr}`);
    const optimized = getOptimizedPattern(patternStr);
    if (optimized !== patternStr.replace(/\s+/g, ' ').trim()) {
        console.log(`Optimized: ${optimized}`);
    }
    console.log('='.repeat(60));

    try {
        const pattern = parsePattern(patternStr);
        printPattern(pattern);

        const executor = new NFAExecutor(pattern);

        console.log('\nExecution:');
        let matched = false;
        let matchRange = null;

        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            const isEOF = input === null;
            const trueVars = isEOF ? [] : input;
            const result = executor.processRow(trueVars);
            const inputStr = isEOF ? 'EOF' : (input.join(' ') || '-');
            console.log(`  Row ${i}: ${inputStr}`);

            // Show absorbed contexts first (using ID)
            if (result.absorptions && result.absorptions.length > 0) {
                for (const abs of result.absorptions) {
                    console.log(`    #${abs.absorbedId}: absorbed by #${abs.byId}`);
                    // Show absorbed context's states
                    if (abs.states && abs.states.length > 0) {
                        for (const s of abs.states) {
                            const elem = pattern.elements[s.elementIndex];
                            if (!elem) continue;
                            const stateInfo = `[${s.elementIndex}:${getVarName(pattern, elem.varId)}]`;
                            for (let pathIdx = 0; pathIdx < s.matchedPaths.length; pathIdx++) {
                                const path = s.matchedPaths[pathIdx];
                                const pathStr = pathToString(pattern, path);
                                if (pathIdx === 0) {
                                    console.log(`      state: ${pathStr} → ${stateInfo}`);
                                } else {
                                    console.log(`             ${pathStr} → ${stateInfo}`);
                                }
                            }
                        }
                    }
                }
            }

            // Show all contexts with their status
            for (const ctx of result.contexts) {
                // Get state merges for this context
                const ctxMerges = (result.stateMerges || []).filter(m => m.contextId === ctx.id);
                // Determine context status
                const hasCompletedPaths = ctx.completedPaths && ctx.completedPaths.length > 0;
                const isMatched = ctx.isCompleted;  // Only truly completed
                const isPotential = !ctx.isCompleted && ctx.matchEnd >= 0;  // Can complete but still active
                const isActive = ctx.states && ctx.states.length > 0 && !ctx.isCompleted;

                // Skip dead contexts (no states and not matched)
                if (!isActive && !isMatched) continue;

                // Determine status label and print context header (using ID)
                if (isMatched) {
                    console.log(`    #${ctx.id}: matched (rows ${ctx.matchStart}-${ctx.matchEnd})`);
                } else if (isPotential) {
                    console.log(`    #${ctx.id}: active (potential: rows ${ctx.matchStart}-${ctx.matchEnd})`);
                } else {
                    console.log(`    #${ctx.id}: active`);
                }

                // Show active states (waiting for next match) - only if not yet matched
                // Format: state: vars → [elemIdx:VAR] → expected
                // Group by elementIndex: merge state(merged) paths and active state paths together
                if (isActive && !isMatched) {
                    // Build groups by elementIndex
                    const groups = new Map(); // elementIndex -> { mergedPaths: [], activePaths: [], expectedStr }

                    // Add merged paths
                    for (const merge of ctxMerges) {
                        const elemIdx = merge.elementIndex;
                        if (!groups.has(elemIdx)) {
                            groups.set(elemIdx, { mergedPaths: [], activePaths: [] });
                        }
                        for (const path of merge.absorbedPaths) {
                            groups.get(elemIdx).mergedPaths.push(path);
                        }
                    }

                    // Add active state paths
                    for (const s of ctx.states) {
                        const elemIdx = s.elementIndex;
                        if (!groups.has(elemIdx)) {
                            groups.set(elemIdx, { mergedPaths: [], activePaths: [] });
                        }
                        for (const path of s.matchedPaths) {
                            groups.get(elemIdx).activePaths.push(path);
                        }
                    }

                    // Print each group
                    for (const [elemIdx, group] of groups) {
                        const elem = pattern.elements[elemIdx];
                        if (!elem) continue;
                        const stateInfo = `[${elemIdx}:${getVarName(pattern, elem.varId)}]`;

                        // Merged paths first
                        for (const path of group.mergedPaths) {
                            const pathStr = pathToString(pattern, path);
                            console.log(`      state(merged): ${pathStr} → ${stateInfo}`);
                        }

                        // Active paths
                        for (let i = 0; i < group.activePaths.length; i++) {
                            const pathStr = pathToString(pattern, group.activePaths[i]);
                            if (i === 0) {
                                console.log(`      state: ${pathStr} → ${stateInfo}`);
                            } else {
                                console.log(`             ${pathStr} → ${stateInfo}`);
                            }
                        }
                    }
                }

                // Show completed paths if matched (each on separate line)
                // Path format: [id, ...varIds] - ID at the front
                if (isMatched && hasCompletedPaths) {
                    const completedPaths = ctx.completedPaths;
                    const maxLen = Math.max(...completedPaths.map(p => p.length), 0);
                    const finalPaths = completedPaths.filter(p => p.length === maxLen);
                    for (const path of finalPaths) {
                        // path[0] is ID, rest is the matched varIds
                        const pathVarIds = path.slice(1);
                        const pathStr = pathToString(pattern, pathVarIds);
                        console.log(`      match: ${pathStr} → ✓`);
                    }

                    if (!matched) {
                        matched = true;
                        matchRange = { start: ctx.matchStart, end: ctx.matchEnd };
                    }
                }
            }

            // Show verbose logs
            if (verbose) {
                for (const log of result.logs) {
                    console.log(`      [${log.type}] ${log.message}`);
                }
            }
        }

        // EOF handling: contexts with matchEnd >= 0 are completed matches
        for (const ctx of executor.contexts) {
            if (!ctx.isCompleted && ctx.matchEnd >= 0) {
                ctx.isCompleted = true;
                if (!matched) {
                    matched = true;
                    matchRange = { start: ctx.matchStart, end: ctx.matchEnd };
                    console.log(`    *** MATCH (EOF): rows ${matchRange.start}-${matchRange.end} ***`);
                }
            }
        }

        const passed = matched === expectedMatch;
        console.log(`\nResult: ${passed ? '✓ PASS' : '✗ FAIL'}`);
        if (!passed) {
            console.log(`  Expected match: ${expectedMatch}, Got: ${matched}`);
        }

        return passed;
    } catch (e) {
        console.log(`\n✗ ERROR: ${e.message}`);
        console.log(e.stack);
        return false;
    }
}

// ============== Run Tests ==============

console.log('RPR NFA Simulator - Test Suite');
console.log('Based on RPR_NFA_CONCEPT.md examples\n');

let passed = 0;
let failed = 0;

// Test 1: Section 5.1 - Simple sequence A B+ C
if (runTest(
    '5.1 Simple Sequence: A B+ C',
    'A B+ C',
    [
        ['A'],      // Row 0: A=T
        ['B'],      // Row 1: B=T
        ['B'],      // Row 2: B=T
        ['C']       // Row 3: C=T
    ],
    true
)) passed++; else failed++;

// Test 2: A B+ C with no match (missing B)
if (runTest(
    'A B+ C - No Match (B missing)',
    'A B+ C',
    [
        ['A'],      // Row 0: A=T
        ['C']       // Row 1: C=T (B missing, should fail)
    ],
    false
)) passed++; else failed++;

// Test 3: A B* C (B is optional)
if (runTest(
    'A B* C - B optional',
    'A B* C',
    [
        ['A'],      // Row 0: A=T
        ['C']       // Row 1: C=T (B skipped)
    ],
    true
)) passed++; else failed++;

// Test 4: Section 3.2 - Alternation A | B | C
if (runTest(
    '3.2 Alternation: ( A | B | C )',
    '( A | B | C )',
    [
        ['B']       // Row 0: B=T
    ],
    true
)) passed++; else failed++;

// Test 5: Section 5.2 - ((A B) | (C D)) E (first alternative)
if (runTest(
    '5.2 Nested Alternation: ((A B)|(C D)) E - Path A B',
    '( ( A B ) | ( C D ) ) E',
    [
        ['A'],      // Row 0: A=T
        ['B'],      // Row 1: B=T
        ['E']       // Row 2: E=T
    ],
    true
)) passed++; else failed++;

// Test 6: ((A B) | (C D)) E (second alternative)
if (runTest(
    '5.2 Nested Alternation: ((A B)|(C D)) E - Path C D',
    '( ( A B ) | ( C D ) ) E',
    [
        ['C'],      // Row 0: C=T
        ['D'],      // Row 1: D=T
        ['E']       // Row 2: E=T
    ],
    true
)) passed++; else failed++;

// Test 7: Section 5.3 - Group repetition (A B){2,3} C
if (runTest(
    '5.3 Group Repetition: (A B){2,3} C - 2 iterations',
    '( A B ){2,3} C',
    [
        ['A'],      // Row 0: A
        ['B'],      // Row 1: B (1st AB)
        ['A'],      // Row 2: A
        ['B'],      // Row 3: B (2nd AB)
        ['C']       // Row 4: C
    ],
    true
)) passed++; else failed++;

// Test 8: (A B){2,3} C - 3 iterations
if (runTest(
    '5.3 Group Repetition: (A B){2,3} C - 3 iterations',
    '( A B ){2,3} C',
    [
        ['A'],      // Row 0: A
        ['B'],      // Row 1: B (1st AB)
        ['A'],      // Row 2: A
        ['B'],      // Row 3: B (2nd AB)
        ['A'],      // Row 4: A
        ['B'],      // Row 5: B (3rd AB)
        ['C']       // Row 6: C
    ],
    true
)) passed++; else failed++;

// Test 9: (A B){2,3} C - only 1 iteration (should fail)
if (runTest(
    '5.3 Group Repetition: (A B){2,3} C - 1 iteration (fail)',
    '( A B ){2,3} C',
    [
        ['A'],      // Row 0: A
        ['B'],      // Row 1: B (1st AB only)
        ['C']       // Row 2: C (need at least 2 AB)
    ],
    false
)) passed++; else failed++;

// Test 10: A B+ C* (C is optional, pattern can end after B)
if (runTest(
    'A B+ C* - End without C',
    'A B+ C*',
    [
        ['A'],      // Row 0: A=T
        ['B'],      // Row 1: B=T
        ['B'],      // Row 2: B=T
        null        // Row 3: EOF (pattern should complete)
    ],
    true
)) passed++; else failed++;

// Test 11: Extreme Pattern - nested groups, multi-level alternation, excessive quantifiers
// ((A | B)+ (C | D)*){1,2} ((E F) | (G H)){2,} I?
if (runTest(
    'EXTREME: ((A|B)+ (C|D)*){1,2} ((E F)|(G H)){2,} I?',
    '((A | B)+ (C | D)*){1,2} ((E F) | (G H)){2,} I?',
    [
        ['A'],      // Row 0: A (first inner group, A|B)
        ['B'],      // Row 1: B (A|B continues)
        ['C'],      // Row 2: C (C|D optional)
        ['A'],      // Row 3: A (second outer group iteration)
        ['D'],      // Row 4: D (C|D in second)
        ['E'],      // Row 5: E (first EF)
        ['F'],      // Row 6: F
        ['G'],      // Row 7: G (second GH)
        ['H'],      // Row 8: H (min 2 satisfied)
        ['I']       // Row 9: I (optional)
    ],
    true
)) passed++; else failed++;

// Test 12: Extreme Pattern - alternative path (G H first)
if (runTest(
    'EXTREME: ((A|B)+ (C|D)*){1,2} ((E F)|(G H)){2,} - GH path, no I',
    '((A | B)+ (C | D)*){1,2} ((E F) | (G H)){2,} I?',
    [
        ['B'],      // Row 0: B
        ['G'],      // Row 1: G (first GH)
        ['H'],      // Row 2: H
        ['E'],      // Row 3: E (second EF)
        ['F'],      // Row 4: F
        null        // Row 5: EOF (I skipped)
    ],
    true
)) passed++; else failed++;

// Test 13: Extreme Pattern - minimum requirement not met (insufficient repetitions)
if (runTest(
    'EXTREME: ((E F)|(G H)){2,} - only 1 iteration (fail)',
    '((E F) | (G H)){2,}',
    [
        ['E'],      // Row 0: E
        ['F'],      // Row 1: F (only 1 iteration, need 2+)
        null        // Row 2: EOF
    ],
    false
)) passed++; else failed++;

// Test 14: Deep nesting (((A)+)+)+
if (runTest(
    'Deep Nesting: (((A)+)+)+',
    '(((A)+)+)+',
    [
        ['A'],      // Row 0
        ['A'],      // Row 1
        ['A'],      // Row 2
        null        // Row 3: EOF
    ],
    true
)) passed++; else failed++;

// Test 15: EXTREME pattern - A, C, C then E, F, E, F for matching
// This test verifies waiting state is correctly maintained when VAR doesn't match
if (runTest(
    'EXTREME: A C C E F E F (waiting for E/G after C)',
    '((A | B)+ (C | D)*){1,2} ((E F) | (G H)){2,} I?',
    [
        ['A'],      // Row 0: A (A|B match)
        ['C'],      // Row 1: C (C|D match)
        ['C'],      // Row 2: C (C|D continues)
        ['E'],      // Row 3: E (first EF start)
        ['F'],      // Row 4: F (first EF complete)
        ['E'],      // Row 5: E (second EF start)
        ['F'],      // Row 6: F (second EF complete, min=2 satisfied)
        null        // Row 7: EOF (I skipped, pattern complete)
    ],
    true
)) passed++; else failed++;

// Test 16: EXTREME pattern - A, C, C then nothing should fail (min=2 not met)
if (runTest(
    'EXTREME: A C C then nothing (fail - need EF/GH x2)',
    '((A | B)+ (C | D)*){1,2} ((E F) | (G H)){2,} I?',
    [
        ['A'],      // Row 0: A
        ['C'],      // Row 1: C
        ['C'],      // Row 2: C
        null        // Row 3: EOF - EF/GH requires min=2
    ],
    false
)) passed++; else failed++;

// Test 17: Multiple vars true simultaneously - A B+ C with A,B both true
if (runTest(
    'Multi-var: A B+ C with [A,B] simultaneous',
    'A B+ C',
    [
        ['A', 'B'],  // Row 0: A=T, B=T (A matches, B also available)
        ['B'],       // Row 1: B=T
        ['C']        // Row 2: C=T
    ],
    true
)) passed++; else failed++;

// Test 18: Alternation with multiple vars true - (A | B) C
if (runTest(
    'Multi-var: (A | B) C with [A,B] simultaneous',
    '(A | B) C',
    [
        ['A', 'B'],  // Row 0: both A and B true (either can match)
        ['C']        // Row 1: C=T
    ],
    true
)) passed++; else failed++;

// Test 19: A B C with all three true in one row - should NOT match
// Each pattern element must match in a separate row
if (runTest(
    'Multi-var: A B C with [A,B,C] all true (no match - need 3 rows)',
    'A B C',
    [
        ['A', 'B', 'C']  // Row 0: all true, but only A matches (1 row = 1 match)
    ],
    false  // No match - pattern needs 3 rows minimum
)) passed++; else failed++;

// Test 20: A+ with A true multiple times
if (runTest(
    'Multi-var: A+ with [A,B] then [A]',
    'A+',
    [
        ['A', 'B'],  // Row 0: A=T (B irrelevant)
        ['A'],       // Row 1: A=T
        null         // Row 2: EOF
    ],
    true
)) passed++; else failed++;

// Test 21: Excessive repetition beyond max - ctx[0] dies, new ctx matches later
// Absorption only applies to infinite repetition (max=Infinity)
// With max=3, after 3 iterations ctx[0] waits for C, dies when A comes, new ctx starts
if (runTest(
    'Finite max: (A B){2,3} C - 5 iterations, match rows 6-10',
    '( A B ){2,3} C',
    [
        ['A'],      // Row 0: A (1st)
        ['B'],      // Row 1: B
        ['A'],      // Row 2: A (2nd)
        ['B'],      // Row 3: B
        ['A'],      // Row 4: A (3rd, max reached)
        ['B'],      // Row 5: B - ctx[0] now waits for C only
        ['A'],      // Row 6: A - ctx[0] dies, new ctx[6] starts
        ['B'],      // Row 7: B
        ['A'],      // Row 8: A (2nd for ctx[6])
        ['B'],      // Row 9: B - ctx[6] can now match C
        ['C']       // Row 10: C - ctx[6] matches rows 6-10
    ],
    true
)) passed++; else failed++;

// Test 22: Infinite repetition absorption - A+ should absorb later starts
if (runTest(
    'Absorption: A+ B - later ctx absorbed by earlier',
    'A+ B',
    [
        ['A'],      // Row 0: A - ctx[0] starts
        ['A'],      // Row 1: A - ctx[0] continues, ctx[1] would start but absorbed
        ['A'],      // Row 2: A - ctx[0] continues, ctx[2] would start but absorbed
        ['B']       // Row 3: B - ctx[0] matches rows 0-3
    ],
    true
)) passed++; else failed++;

// Test 23: Multiple overlapping matches - (A B){2,3} C with 3 iterations
// ctx[0] matches rows 0-6 (3 AB), ctx[2] matches rows 2-6 (2 AB)
if (runTest(
    'Overlap: (A B){2,3} C - 3 iterations, 2 matches',
    '( A B ){2,3} C',
    [
        ['A'],      // Row 0: A (1st for ctx[0])
        ['B'],      // Row 1: B
        ['A'],      // Row 2: A (2nd for ctx[0], 1st for ctx[2])
        ['B'],      // Row 3: B
        ['A'],      // Row 4: A (3rd for ctx[0], 2nd for ctx[2])
        ['B'],      // Row 5: B
        ['C']       // Row 6: C - both ctx[0] and ctx[2] match
    ],
    true  // At least one match
)) passed++; else failed++;

// Test 24: Match deferral - A C+ pattern should defer match until C stops coming
// The match should complete only after C stops matching
if (runTest(
    'Match Deferral: A C+ - defer until C stops',
    'A C+',
    [
        ['A'],      // Row 0: A - match starts
        ['C'],      // Row 1: C - min satisfied, but could get more C
        ['C'],      // Row 2: C - still matching
        ['C'],      // Row 3: C - still matching
        ['B']       // Row 4: B - C stops, now match completes at row 3
    ],
    true
)) passed++; else failed++;

// Test 25: A C+ with EOF - match should complete when no more input
if (runTest(
    'Match Deferral: A C+ - complete at EOF',
    'A C+',
    [
        ['A'],      // Row 0: A - match starts
        ['C'],      // Row 1: C - min satisfied, but could get more C
        ['C'],      // Row 2: C - still matching
        []          // Row 3: EOF - match completes at row 2
    ],
    true
)) passed++; else failed++;

// Test 26: A+ (B|A)+ - Lexical Order test (from RPR_NFA_LEXICAL_ORDER_JA.md 6.4)
if (runTest(
    'Lexical Order: A+ (B|A)+ with [A,B] x3 then empty',
    'A+ ( B | A )+',
    [
        ['A', 'B'],  // Row 0: A=T, B=T
        ['A', 'B'],  // Row 1: A=T, B=T
        ['A', 'B'],  // Row 2: A=T, B=T
        []           // Row 3: empty - match completes
    ],
    true
)) passed++; else failed++;

// Test 27: Greedy Fallback - (A | B C)+ with fallback to earlier completion
if (runTest(
    'Greedy Fallback: (A | B C)+ - fallback to Row 0 completion',
    '( A | B C )+',
    [
        ['A'],      // Row 0: A matches -> completion preserved
        ['B'],      // Row 1: B matches -> waiting for C
        ['D']       // Row 2: D (not C) -> B C path dies, fallback to A
    ],
    true  // Should match with path [A] from Row 0
)) passed++; else failed++;

// Test 28: Greedy Fallback - longer sequence (A | B C D E)+
if (runTest(
    'Greedy Fallback: (A | B C D E)+ - 4-row fallback',
    '( A | B C D E )+',
    [
        ['A'],      // Row 0: A matches -> completion preserved
        ['B'],      // Row 1: B matches -> waiting for C
        ['C'],      // Row 2: C matches -> waiting for D
        ['D'],      // Row 3: D matches -> waiting for E
        ['X']       // Row 4: X (not E) -> B C D E dies, fallback to A
    ],
    true  // Should match with path [A] from Row 0
)) passed++; else failed++;

// Test 29: Greedy Fallback - no fallback needed (longer path succeeds)
if (runTest(
    'Greedy Fallback: (A | B C)+ - longer path succeeds, no fallback',
    '( A | B C )+',
    [
        ['A'],      // Row 0: A matches -> completion preserved
        ['B'],      // Row 1: B matches -> waiting for C
        ['C']       // Row 2: C matches -> B C completes (longer than A)
    ],
    true  // Should match with path [A B C], not fallback
)) passed++; else failed++;

// Test 30: Greedy Fallback - multiple completions, best preserved
if (runTest(
    'Greedy Fallback: (A | B)+ - multiple completions, fallback to longest',
    '( A | B )+',
    [
        ['A'],      // Row 0: A matches -> completion [A] preserved
        ['B'],      // Row 1: B matches -> completion [A B] preserved (longer)
        ['C']       // Row 2: C (no match) -> fallback to [A B]
    ],
    true  // Should match with path [A B]
)) passed++; else failed++;

// Summary
console.log('\n' + '='.repeat(60));
console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
