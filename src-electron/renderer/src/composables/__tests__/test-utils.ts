/**
 * Test utilities for useChat handler tests.
 *
 * Re-exports the internal __test_registerGlobalHandlers in a dedicated
 * test module so the production useChat.ts doesn't pollute its public API.
 */

// Re-export the test helper from the production module.
// This file exists so test imports are from a test-utils path rather than
// the production module's public surface.
export { __test_registerGlobalHandlers } from '../useChat'
