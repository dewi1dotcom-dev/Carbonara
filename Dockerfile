FROM python:3.12-slim-bookworm

# OCR + barcode libraries used for VIN recognition
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr libzbar0 libdmtx0b \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend
COPY VERSION VERSION
# Stamp the build time (UTC) so the footer shows exactly which build is running.
RUN date -u +"%Y-%m-%d %H:%M UTC" > BUILD_TIME

WORKDIR /app/backend
ENV PHOTO_DIR=/data/photos \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
