// Fixture for the Blackbox debug-loop test (src/test/suite/loop.test.ts).
// The test refers to these line numbers; keep them stable.
function add(a, b) {
    return a + b;
}

let total = 0;
for (let i = 1; i <= 2; i++) {
    total = add(total, i); // line 9: breakpoint
    console.log('total', total); // line 10: logpoint
}
try {
    throw new Error('caught boom'); // line 13: exception
} catch (err) {
    console.log('handled', err.message);
}
