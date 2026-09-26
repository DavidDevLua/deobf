# deobf web front end.
#
# Stage 1 builds the patched Luau runtime (the vector metatable is left
# writable so Roblox's Vector3 members work; see deobf/build_luau.py).
# Stage 2 is the runtime image: Python, the pipeline, and those two binaries.
#
#   docker build -t deobf .
#   docker run --rm -p 8000:8000 deobf

FROM debian:bookworm-slim AS luau
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY deobf/build_luau.py deobf/build_luau.py
# --portable: no -march=native, so the image runs on any x86-64 host
RUN python3 deobf/build_luau.py --portable

FROM python:3.11-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEOB_HOST=0.0.0.0 \
    PORT=8000
WORKDIR /app

COPY web/requirements.txt web/requirements.txt
RUN pip install --no-cache-dir -r web/requirements.txt

COPY deobf/ deobf/
COPY web/ web/
COPY samples/ samples/
COPY CLAUDE.md LURAPH.md IRONBREW1.md ./
COPY --from=luau /src/deobf/bin/luau /src/deobf/bin/luau-ast deobf/bin/

# the traced script is untrusted: run it as a plain user
RUN useradd --create-home --uid 10001 deobf && chown -R deobf:deobf /app
USER deobf

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["python", "web/server.py"]
