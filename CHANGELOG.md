#1.1.1
## Bug fixes
- Client can now initialize with websocket disabled.
- Client will now properly send headers in long poll mode.
## Changes
- None

#1.1.0
## Bug fixes
- None 
## Changes
- Replaced integer IDs with uuids as supported by the server.

#1.0.1
## Bug fixes
- Removed a stray line which caused 1.0.0 to fail where commonJS is unavailable. 1.0.0 has been unpublished
## Changes
- None

# 1.0.0
## Bug fixes
- None
## Changes
- Refactored factory to not assume protocol and host url. Instead these must now be passed as parameters