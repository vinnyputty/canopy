# The service backend and bounded native verifier are implemented in windows-signing.mjs.
# Fail closed for callers of the obsolete in-process/private-key interface.
throw 'Use node tools/windows-signing.mjs verify; private-key import and in-process signing are unsupported'
