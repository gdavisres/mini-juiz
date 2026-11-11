FROM gcc:14-bookworm
COPY --chmod=0555 runner.sh /usr/local/bin/judge-runner
ENV TMPDIR=/work
USER 65534:65534
ENTRYPOINT ["/usr/bin/timeout", "--kill-after=1s", "20s", "/usr/local/bin/judge-runner"]
