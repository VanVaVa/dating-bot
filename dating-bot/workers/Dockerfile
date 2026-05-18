FROM python:3.12-slim AS base

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY celery_app.py tasks.py /app/

ENV PYTHONUNBUFFERED=1
