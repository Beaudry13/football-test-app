// WHICH ENGINE THE CHARACTERIZATION TESTS CHECK.
//
// Step 1 of P1 points this at the preserved prototype, proving the goldens
// describe the validated behaviour before anything moves. Once the engine is
// in PEIRA, this points at PEIRA's copy - and the same goldens must still
// pass. That one-line switch is the whole claim of the integration.
export { prototypeEngine as engineUnderTest, prototypeModel as modelUnderTest } from './prototypeEngine'
