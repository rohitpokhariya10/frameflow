import { existsSync } from 'node:fs';
/**
 * The client's reference creative (Ganesh-Chaturthi.png), the recorded provider answers and artwork made from it
 * (tests/fixtures/recorded/) and its hand-made manifest (tests/fixtures/ganeshHandmade.fixture.ts) are confidential and
 * kept out of the repository. The tests that replay them run only where they are present; elsewhere they are skipped.
 */
export const HAS_PRIVATE_FIXTURES = existsSync('Ganesh-Chaturthi.png') && existsSync('tests/fixtures/recorded') && existsSync('tests/fixtures/ganeshHandmade.fixture.ts');
