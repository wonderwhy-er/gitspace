#!/bin/zsh
# Double-click in Finder to build and open Gitspace.
cd "$(dirname "$0")" || exit 1

# Finder-launched Terminal sessions may not inherit the usual Node PATH.
if ! command -v npm >/dev/null 2>&1; then
  for bin in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.nvm/current/bin"; do
    [[ -x "$bin/npm" ]] && export PATH="$bin:$PATH" && break
  done
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Cannot find npm. Install Node.js or configure npm in your shell PATH."
  read '?Press Return to close...'
  exit 1
fi

echo "Launching Gitspace..."
npm run app
result=$?
if (( result != 0 )); then
  echo "Gitspace exited with code $result."
  read '?Press Return to close...'
fi
exit $result
