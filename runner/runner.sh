#!/bin/bash
set -eu
cd /work

case "$1" in
  compile)
    ulimit -f 512
    cat > submission.cpp
    timeout --kill-after=1s 15s g++ -std=c++17 -O2 -pipe submission.cpp -o solution 2> diagnostics || {
      cat diagnostics >&2
      exit 10
    }
    cat solution
    ;;
  run)
    read -r size
    head -c "$size" > solution
    chmod 0500 solution
    cat > input
    ulimit -f 64
    code=0
    timeout --kill-after=1s "${2}s" ./solution < input > output 2>/dev/null || code=$?
    case "$code" in
      0) cat output ;;
      124|137) exit 124 ;;
      *) exit 11 ;;
    esac
    ;;
  *) exit 125 ;;
esac
