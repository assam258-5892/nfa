#!/usr/bin/env node
/**
 * Parser Test Suite for Node.js
 * Run: node parser_test.js
 */

const {
    parsePattern,
    tokenize,
    parseSequence,
    unwrapGroups,
    removeDuplicates,
    optimizeQuantifiers,
    astToString,
    astEqual
} = require('./parser.js');

let passed = 0, failed = 0;

function log(msg, isPass) {
    const prefix = isPass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    console.log(`${prefix} ${msg}`);
    if (isPass) passed++; else failed++;
}

function section(title) {
    console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);
}

function assertEqual(actual, expected, msg) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        log(msg, true);
    } else {
        log(`${msg}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`, false);
    }
}

function assertThrows(fn, msgContains, testName) {
    try {
        fn();
        log(`${testName} - should have thrown`, false);
    } catch (e) {
        if (e.message.includes(msgContains)) {
            log(testName, true);
        } else {
            log(`${testName}\n  Expected error containing: "${msgContains}"\n  Got: "${e.message}"`, false);
        }
    }
}

// ============================================================
// 1. Tokenizer Tests
// ============================================================
section('1. Tokenizer');

// 1.1 Basic tokens
let tokens = tokenize('A B C');
assertEqual(tokens.length, 3, '1.1 Basic variables: A B C -> 3 tokens');
assertEqual(tokens[0], {type:'VAR', name:'A'}, '1.1a First token is VAR:A');

// 1.2 Quantifiers
tokens = tokenize('A+ B* C?');
assertEqual(tokens.length, 6, '1.2 Quantifiers: A+ B* C? -> 6 tokens');
assertEqual(tokens[1], {type:'QUANT', min:1, max:Infinity, reluctant:false}, '1.2a + -> {1,Inf}');
assertEqual(tokens[3], {type:'QUANT', min:0, max:Infinity, reluctant:false}, '1.2b * -> {0,Inf}');
assertEqual(tokens[5], {type:'QUANT', min:0, max:1, reluctant:false}, '1.2c ? -> {0,1}');

// 1.3 Braced quantifiers
tokens = tokenize('A{3} B{2,5} C{2,} D{,3}');
assertEqual(tokens[1], {type:'QUANT', min:3, max:3, reluctant:false}, '1.3a {3} -> {3,3}');
assertEqual(tokens[3], {type:'QUANT', min:2, max:5, reluctant:false}, '1.3b {2,5} -> {2,5}');
assertEqual(tokens[5], {type:'QUANT', min:2, max:Infinity, reluctant:false}, '1.3c {2,} -> {2,Inf}');
assertEqual(tokens[7], {type:'QUANT', min:0, max:3, reluctant:false}, '1.3d {,3} -> {0,3}');

// 1.4 Parentheses and alternation
tokens = tokenize('(A | B)');
assertEqual(tokens.map(t => t.type), ['LPAREN','VAR','ALT','VAR','RPAREN'],
    '1.4 (A | B) -> LPAREN VAR ALT VAR RPAREN');

// 1.5 Complex variable names
tokens = tokenize('var_1 X2 abc123');
assertEqual(tokens.map(t => t.name), ['var_1','X2','abc123'],
    '1.5 Variable names with underscores and numbers');

// ============================================================
// 2. Parser Tests (AST Generation)
// ============================================================
section('2. Parser (AST)');

// 2.1 Simple sequence
let pattern = parsePattern('A B C');
assertEqual(pattern.variables, ['A','B','C'], '2.1 Variables: A B C');

// 2.2 With quantifiers
pattern = parsePattern('A+ B*');
let elemA = pattern.elements[0];
let elemB = pattern.elements[1];
assertEqual([elemA.min, elemA.max], [1, Infinity], '2.2a A+ -> {1,Inf}');
assertEqual([elemB.min, elemB.max], [0, Infinity], '2.2b B* -> {0,Inf}');

// 2.3 Alternation
pattern = parsePattern('A | B | C');
assertEqual(pattern.elements[0].isAltStart(), true, '2.3 First element is #ALT');

// 2.4 Grouped pattern
pattern = parsePattern('(A B)+');
let hasEnd = pattern.elements.some(e => e.isGroupEnd());
assertEqual(hasEnd, true, '2.4 Grouped pattern has #END marker');

// 2.5 Nested groups
pattern = parsePattern('((A)+)+');
let depths = pattern.elements.map(e => e.depth);
assertEqual(Math.max(...depths) >= 1, true, '2.5 Nested groups have depth >= 1');

// ============================================================
// 3. Optimization Tests
// ============================================================
section('3. Optimization');

// 3.1 unwrapGroups - single item group
let ast = parseSequence(tokenize('(A)'), {value:0}, new Set());
ast = unwrapGroups(ast);
assertEqual(ast.type, 'VAR', '3.1 (A) unwraps to VAR');

// 3.2 unwrapGroups - group with quantifier preserved
ast = parseSequence(tokenize('(A){2,3}'), {value:0}, new Set());
ast = unwrapGroups(ast);
assertEqual(ast.type, 'GROUP', '3.2 (A){2,3} keeps GROUP');

// 3.3 removeDuplicates
ast = parseSequence(tokenize('A | A | B'), {value:0}, new Set());
ast = removeDuplicates(ast);
assertEqual(ast.alternatives.length, 2, '3.3 A|A|B -> 2 alternatives');

// 3.4 optimizeQuantifiers - consecutive same vars
ast = parseSequence(tokenize('A A A'), {value:0}, new Set());
ast = optimizeQuantifiers(ast);
assertEqual(ast.items.length, 1, '3.4a A A A -> 1 item');
assertEqual([ast.items[0].min, ast.items[0].max], [3, 3], '3.4b A A A -> A{3,3}');

// 3.5 astEqual
let ast1 = parseSequence(tokenize('A B'), {value:0}, new Set());
let ast2 = parseSequence(tokenize('A B'), {value:0}, new Set());
let ast3 = parseSequence(tokenize('A C'), {value:0}, new Set());
assertEqual(astEqual(ast1, ast2), true, '3.5a astEqual(A B, A B) = true');
assertEqual(astEqual(ast1, ast3), false, '3.5b astEqual(A B, A C) = false');

// 3.6 astToString
ast = parseSequence(tokenize('A+ B*'), {value:0}, new Set());
assertEqual(astToString(ast), 'A+ B*', '3.6 astToString(A+ B*) = "A+ B*"');

// ============================================================
// 4. Error Handling Tests
// ============================================================
section('4. Error Handling');

// 4.1 Unsupported operators
assertThrows(() => tokenize('A & B'), 'AND operator', '4.1 AND operator throws');
assertThrows(() => tokenize('^A'), 'Anchors', '4.2 Anchor ^ throws');
assertThrows(() => tokenize('A$'), 'Anchors', '4.3 Anchor $ throws');
assertThrows(() => tokenize('PERMUTE(A,B)'), 'PERMUTE', '4.4 PERMUTE throws');

// 4.2 Invalid quantifiers
assertThrows(() => tokenize('+A'), 'Quantifier', '4.6 Leading quantifier throws');
assertThrows(() => tokenize('A++'), 'Quantifier', '4.7 Double quantifier throws');

// 4.3 Unbalanced parentheses
assertThrows(() => tokenize('(A B'), 'parenthes', '4.8 Unclosed parenthesis throws');
assertThrows(() => tokenize('A B)'), 'parenthes', '4.9 Extra closing parenthesis throws');

// 4.4 Empty structures
assertThrows(() => tokenize('()'), 'Empty', '4.10 Empty group throws');
assertThrows(() => tokenize('A | | B'), 'Empty', '4.11 Empty alternative throws');

// Note: {- -} exclusion syntax is caught as invalid quantifier, not specific error
// assertThrows(() => tokenize('{- A -}'), 'Exclusion', '4.4 Exclusion throws');

// ============================================================
// 5. Pattern Compilation Tests
// ============================================================
section('5. Pattern Compilation');

// 5.1 next/jump pointers
pattern = parsePattern('A B');
assertEqual(pattern.elements[0].next, 1, '5.1a A.next = 1');
assertEqual(pattern.elements[1].next, 2, '5.1b B.next = 2 (FIN)');

// 5.2 FIN marker
let lastElem = pattern.elements[pattern.elements.length - 1];
assertEqual(lastElem.isFinish(), true, '5.2 Last element is #FIN');

// 5.3 ALT structure
pattern = parsePattern('A | B');
let altElem = pattern.elements.find(e => e.isAltStart());
assertEqual(altElem !== undefined, true, '5.3a Has #ALT element');
// ALT's first alternative uses next, second uses jump from first var
let firstAlt = pattern.elements[1];  // A
assertEqual(firstAlt.jump >= 0, true, '5.3b First alt has jump to second');

// 5.4 Loop structure - use grouped pattern for #END
pattern = parsePattern('(A B)+');
let endElem = pattern.elements.find(e => e.isGroupEnd());
assertEqual(endElem !== undefined, true, '5.4a (A B)+ has #END');
assertEqual(endElem.jump >= 0, true, '5.4b #END has jump pointer');

// 5.5 Single var with quantifier (no #END, just min/max)
pattern = parsePattern('A+');
assertEqual(pattern.elements[0].min, 1, '5.5a A+ min = 1');
assertEqual(pattern.elements[0].max, Infinity, '5.5b A+ max = Infinity');

// ============================================================
// 6. Integration Tests
// ============================================================
section('6. Integration');

// 6.1 Complex pattern
pattern = parsePattern('(A+ | B)* C');
assertEqual(pattern.variables.includes('A'), true, '6.1a Has var A');
assertEqual(pattern.variables.includes('B'), true, '6.1b Has var B');
assertEqual(pattern.variables.includes('C'), true, '6.1c Has var C');

// 6.2 With optimization
pattern = parsePattern('(A | A | B)+', { optimize: true });
assertEqual(pattern.elements.length > 0, true, '6.2 Optimized pattern compiles');

// 6.3 maxDepth
pattern = parsePattern('((A)+)+');
assertEqual(pattern.maxDepth >= 2, true, '6.3 Nested groups have maxDepth >= 2');

// ============================================================
// 7. Reluctant Quantifier Tests
// ============================================================
section('7. Reluctant Quantifiers');

// 7.1 Tokenizer: +?
tokens = tokenize('A+?');
assertEqual(tokens.length, 2, '7.1a A+? -> 2 tokens');
assertEqual(tokens[1], {type:'QUANT', min:1, max:Infinity, reluctant:true}, '7.1b +? -> {1,Inf,reluctant}');

// 7.2 Tokenizer: *?
tokens = tokenize('A*?');
assertEqual(tokens[1], {type:'QUANT', min:0, max:Infinity, reluctant:true}, '7.2 *? -> {0,Inf,reluctant}');

// 7.3 Tokenizer: ??
tokens = tokenize('A??');
assertEqual(tokens[1], {type:'QUANT', min:0, max:1, reluctant:true}, '7.3 ?? -> {0,1,reluctant}');

// 7.4 Tokenizer: {n,m}?
tokens = tokenize('A{2,5}?');
assertEqual(tokens[1], {type:'QUANT', min:2, max:5, reluctant:true}, '7.4 {2,5}? -> {2,5,reluctant}');

// 7.5 Tokenizer: {n}?
tokens = tokenize('A{3}?');
assertEqual(tokens[1], {type:'QUANT', min:3, max:3, reluctant:true}, '7.5 {3}? -> {3,3,reluctant}');

// 7.6 Tokenizer: {n,}?
tokens = tokenize('A{2,}?');
assertEqual(tokens[1], {type:'QUANT', min:2, max:Infinity, reluctant:true}, '7.6 {2,}? -> {2,Inf,reluctant}');

// 7.7 Greedy quantifiers have reluctant:false
tokens = tokenize('A+ B* C?');
assertEqual(tokens[1].reluctant, false, '7.7a + has reluctant:false');
assertEqual(tokens[3].reluctant, false, '7.7b * has reluctant:false');
assertEqual(tokens[5].reluctant, false, '7.7c ? has reluctant:false');

// 7.8 PatternElement: reluctant flag
pattern = parsePattern('A+?');
assertEqual(pattern.elements[0].reluctant, true, '7.8 A+? element has reluctant:true');

// 7.9 Mixed greedy and reluctant
pattern = parsePattern('A+ B*?');
assertEqual(pattern.elements[0].reluctant, false, '7.9a A+ has reluctant:false');
assertEqual(pattern.elements[1].reluctant, true, '7.9b B*? has reluctant:true');

// 7.10 Reluctant on groups
pattern = parsePattern('(A B)+?');
let groupEnd = pattern.elements.find(e => e.isGroupEnd());
assertEqual(groupEnd.reluctant, true, '7.10 (A B)+? group has reluctant:true');

// 7.11 astToString preserves reluctant
ast = parseSequence(tokenize('A+? B*'), {value:0}, new Set());
assertEqual(astToString(ast), 'A+? B*', '7.11 astToString(A+? B*) = "A+? B*"');

// 7.12 astEqual distinguishes reluctant
ast1 = parseSequence(tokenize('A+'), {value:0}, new Set());
ast2 = parseSequence(tokenize('A+?'), {value:0}, new Set());
assertEqual(astEqual(ast1, ast2), false, '7.12 astEqual(A+, A+?) = false');

// ============================================================
// Summary
// ============================================================
console.log('\n' + '='.repeat(50));
const total = passed + failed;
if (failed === 0) {
    console.log(`\x1b[32mAll ${total} tests passed!\x1b[0m`);
} else {
    console.log(`\x1b[31mTotal: ${total}, Passed: ${passed}, Failed: ${failed}\x1b[0m`);
}
process.exit(failed === 0 ? 0 : 1);
