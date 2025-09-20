FROM python:3.10-slim
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir -r requirements.txt || true
ENTRYPOINT ["python", "release_notes_agents.py"]
