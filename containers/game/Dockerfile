FROM python:3.13-slim

RUN pip install --no-cache-dir \
      Pillow==12.3.0 \
      PyBoy==2.7.0 \
 && useradd --uid 10002 --create-home --home-dir /app --shell /usr/sbin/nologin emulator

WORKDIR /app
COPY server.py /app/server.py

RUN chown -R emulator:emulator /app

USER emulator

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["python", "/app/server.py"]
