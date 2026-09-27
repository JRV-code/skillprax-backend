export const TECHNICAL_DOMAINS = [
  { id: "backend-systems", name: "Backend & Distributed Systems", examples: "Node.js, Go, Rust, Microservices, gRPC" },
  { id: "frontend-architecture", name: "Frontend & Web Architecture", examples: "React, Next.js, WebGL, Performance Optimization" },
  { id: "cloud-devops", name: "Cloud Infrastructure & DevOps", examples: "Docker, Kubernetes, Terraform, AWS, CI/CD" },
  { id: "ai-data-engineering", name: "AI, ML & Data Pipelines", examples: "Transformers, PyTorch, Vector DBs, Apache Kafka" },
  { id: "cybersecurity", name: "Security & Cryptography", examples: "Penetration Testing, Zero Trust, OAuth2, Web3 Auditing" },
  { id: "systems-embedded", name: "Systems Programming & Embedded", examples: "C++, Embedded C, RTOS, Linux Kernel, IoT" },
  { id: "database-storage", name: "Database Engineering & Storage Engines", examples: "PostgreSQL Internals, Redis, LSM Trees, Sharding" }
] as const;

export type TechnicalDomainId = typeof TECHNICAL_DOMAINS[number]['id'];
