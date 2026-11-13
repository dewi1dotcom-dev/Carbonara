FROM python:3.12-slim-bookworm

# OCR + barcode libraries used for VIN/plate recognition
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr libzbar0 libdmtx0b \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
# RapidOCR is installed without its own dependency list (it would pull the
# full, GUI-enabled opencv-python); its real dependencies are in
# requirements.txt. The last two lines fail the build early if OCR or the PDF
# libraries (PDI sheets) can't load.
RUN pip install --no-cache-dir -r backend/requirements.txt \
 && pip install --no-cache-dir --no-deps rapidocr-onnxruntime==1.3.24 \
 && python -c "import rapidocr_onnxruntime, cv2, onnxruntime; print('OCR runtime OK')" \
 && python -c "import pypdf, reportlab, pypdfium2; print('PDF libraries OK')"

COPY backend backend
COPY frontend frontend
COPY VERSION VERSION
# Stamp the build time (UTC) so the footer shows exactly which build is running.
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > BUILD_TIME

WORKDIR /app/backend
ENV PHOTO_DIR=/data/photos \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
