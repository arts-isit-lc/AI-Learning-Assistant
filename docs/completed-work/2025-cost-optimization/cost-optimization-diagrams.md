# Cost Optimization Diagrams

## 1. Network Traffic Flow — Before vs After (CO-1, CO-3)

### Before

```mermaid
graph LR
    subgraph VPC
        Lambda[Lambda Functions]
        RDSProxy[RDS Proxy :5432]
        SM_EP[Secrets Manager Endpoint]
        RDS_EP[RDS API Endpoint ❌ unused]
        NAT[NAT Gateway]
    end

    S3[(S3 Buckets)]
    DDB[(DynamoDB)]
    Bedrock[Bedrock API]
    Cognito[Cognito API]
    SM[Secrets Manager]

    Lambda -->|TCP 5432| RDSProxy
    Lambda -->|HTTPS 443| SM_EP
    SM_EP -->|private link| SM

    Lambda -->|via NAT $$| NAT
    NAT -->|$0.045/GB| S3
    NAT -->|$0.045/GB| DDB
    NAT -->|$0.045/GB| Bedrock
    NAT -->|$0.045/GB| Cognito

    RDS_EP -.-|never used| Lambda

    style RDS_EP fill:#ff6b6b,color:#fff
    style NAT fill:#ffa726,color:#fff
```

### After

```mermaid
graph LR
    subgraph VPC
        Lambda[Lambda Functions]
        RDSProxy[RDS Proxy :5432]
        SM_EP[Secrets Manager Endpoint]
        S3_EP[S3 Gateway Endpoint ✅ new]
        DDB_EP[DynamoDB Gateway Endpoint ✅ new]
        NAT[NAT Gateway]
    end

    S3[(S3 Buckets)]
    DDB[(DynamoDB)]
    Bedrock[Bedrock API]
    Cognito[Cognito API]
    SM[Secrets Manager]

    Lambda -->|TCP 5432| RDSProxy
    Lambda -->|HTTPS 443| SM_EP
    SM_EP -->|private link| SM

    Lambda -->|free, AWS backbone| S3_EP
    S3_EP -->|free| S3
    Lambda -->|free, AWS backbone| DDB_EP
    DDB_EP -->|free| DDB

    Lambda -->|via NAT reduced traffic| NAT
    NAT -->|$0.045/GB| Bedrock
    NAT -->|$0.045/GB| Cognito

    style S3_EP fill:#2e7d32,color:#fff
    style DDB_EP fill:#2e7d32,color:#fff
    style NAT fill:#ffa726,color:#fff
```

**Key changes:**
- S3 and DynamoDB traffic no longer routes through NAT Gateway (CO-1)
- RDS API endpoint removed — was never used (CO-3)
- NAT Gateway only handles Bedrock and Cognito traffic now

---

## 2. Lambda Configuration Changes (CO-2, CO-5)

### Memory Allocation — Before vs After

```mermaid
graph LR
    subgraph Before [Before — All at 512MB]
        B1[adminLambdaAuthorizer\n512MB]
        B2[studentLambdaAuthorizer\n512MB]
        B3[instructorLambdaAuthorizer\n512MB]
        B4[adjustUserRoles\n512MB]
        B5[studentFunction\n512MB]
        B6[instructorFunction\n512MB]
        B7[adminFunction\n512MB]
        B8[initializerFunction\n512MB]
    end

    subgraph After [After — Right-sized to 256MB]
        A1[adminLambdaAuthorizer\n256MB · peak 88MB]
        A2[studentLambdaAuthorizer\n256MB · peak 89MB]
        A3[instructorLambdaAuthorizer\n256MB · peak 88MB]
        A4[adjustUserRoles\n256MB · peak 93MB]
        A5[studentFunction\n256MB · peak 101MB]
        A6[instructorFunction\n256MB · peak 100MB]
        A7[adminFunction\n256MB · peak 92MB]
        A8[initializerFunction\n256MB]
    end

    style Before fill:#ff6b6b,color:#fff
    style After fill:#2e7d32,color:#fff
```

### Timeout Changes — Before vs After

```mermaid
gantt
    title Lambda Timeouts (seconds)
    dateFormat X
    axisFormat %s

    section Authorizers
    adminAuth BEFORE     :done, 0, 300
    adminAuth AFTER      :active, 0, 30
    studentAuth BEFORE   :done, 0, 300
    studentAuth AFTER    :active, 0, 30
    instructorAuth BEFORE :done, 0, 300
    instructorAuth AFTER :active, 0, 30

    section Cognito Triggers
    preSignup BEFORE     :done, 0, 300
    preSignup AFTER      :active, 0, 30
    addStudentOnSignUp BEFORE :done, 0, 300
    addStudentOnSignUp AFTER  :active, 0, 30
    adjustUserRoles BEFORE :done, 0, 300
    adjustUserRoles AFTER  :active, 0, 60

    section CRUD Functions
    studentFunc BEFORE   :done, 0, 300
    studentFunc AFTER    :active, 0, 60
    instructorFunc BEFORE :done, 0, 300
    instructorFunc AFTER :active, 0, 60
    adminFunc BEFORE     :done, 0, 300
    adminFunc AFTER      :active, 0, 60

    section Utility Functions
    generatePresignedURL BEFORE :done, 0, 300
    generatePresignedURL AFTER  :active, 0, 30
    getFiles BEFORE      :done, 0, 300
    getFiles AFTER       :active, 0, 30
    deleteFile BEFORE    :done, 0, 300
    deleteFile AFTER     :active, 0, 30
    deleteModule BEFORE  :done, 0, 300
    deleteModule AFTER   :active, 0, 60
    deleteLastMsg BEFORE :done, 0, 300
    deleteLastMsg AFTER  :active, 0, 30
    getChatLogs BEFORE   :done, 0, 300
    getChatLogs AFTER    :active, 0, 60
    sqsFunction BEFORE   :done, 0, 300
    sqsFunction AFTER    :active, 0, 60
    notification BEFORE  :done, 0, 300
    notification AFTER   :active, 0, 60

    section Unchanged
    SQSTrigger           :crit, 0, 300
    TextGenDocker        :crit, 0, 300
    DataIngestDocker     :crit, 0, 600
    initializer          :crit, 0, 300
```

---

## 3. Architecture Overview — Resources Changed

```mermaid
graph TB
    subgraph VPC [VPC — 2 AZs]
        subgraph Public [Public Subnet]
            NAT[NAT Gateway\nKept — reduced traffic]
        end

        subgraph Private [Private Subnet]
            AUTH1[adminLambdaAuthorizer\n🔧 256MB · 30s]
            AUTH2[studentLambdaAuthorizer\n🔧 256MB · 30s]
            AUTH3[instructorLambdaAuthorizer\n🔧 256MB · 30s]
            STUDENT[studentFunction\n🔧 256MB · 60s]
            INSTRUCTOR[instructorFunction\n🔧 256MB · 60s]
            ADMIN[adminFunction\n🔧 256MB · 60s]
            ADJUST[adjustUserRoles\n🔧 256MB · 60s]
            TEXTGEN[TextGenLambdaDockerFunc\n✅ unchanged 1024MB · 300s]
            DATAINGEST[DataIngestLambdaDockerFunc\n✅ unchanged 512MB · 600s]
            SQSTRIGGER[SQSTriggerDockerFunc\n✅ unchanged 512MB · 300s]
        end

        subgraph Isolated [Isolated Subnet]
            RDS[RDS PostgreSQL\n🔧 Dev: 20GB · 1-day backup\n🔧 Prod: 100GB · 7-day backup]
            PROXY1[RDS Proxy User]
            PROXY2[RDS Proxy TableCreator]
            PROXY3[RDS Proxy Admin]
        end

        subgraph Endpoints [VPC Endpoints]
            SM_EP[Secrets Manager\n✅ kept]
            S3_EP[S3 Gateway\n🆕 new — CO-1]
            DDB_EP[DynamoDB Gateway\n🆕 new — CO-1]
            RDS_EP[RDS Interface\n🗑️ removed — CO-3]
        end

        FLOWLOG[VPC Flow Logs\n🔧 6mo prod · 7d dev]
    end

    subgraph External [External Services]
        S3_BUCKETS[S3 Buckets x3\n🔧 Intelligent-Tiering]
        DYNAMODB[DynamoDB]
        BEDROCK[Bedrock]
        COGNITO[Cognito]
    end

    subgraph Monitoring [CloudWatch]
        RDS_LOGS[RDS Logs\n🔧 6mo prod · 14d dev]
        ENHANCED[Enhanced Monitoring\n🔧 prod only · dev disabled]
        APIGW_LOGS[API GW Logs\n🔧 dataTrace disabled]
    end

    subgraph Utility [Utility Lambdas — timeout only]
        PRESIGN[generatePresignedURL\n🔧 30s]
        GETFILES[getFilesFunction\n🔧 30s]
        DELFILE[deleteFile\n🔧 30s]
        DELMOD[deleteModule\n🔧 60s]
        DELMSG[deleteLastMessage\n🔧 30s]
        CHATLOGS[getChatLogsFunction\n🔧 60s]
        SQS[sqsFunction\n🔧 60s]
        NOTIF[notificationFunction\n🔧 60s]
        PRESIGNUP[preSignupLambda\n🔧 30s]
        AUTOSIGNUP[addStudentOnSignUp\n🔧 30s]
    end

    Private -->|TCP 5432| PROXY1
    Private -->|TCP 5432| PROXY2
    PROXY1 --> RDS
    PROXY2 --> RDS
    PROXY3 --> RDS

    Private --> SM_EP
    Private --> S3_EP
    Private --> DDB_EP
    S3_EP --> S3_BUCKETS
    DDB_EP --> DYNAMODB
    Private -->|via NAT| NAT
    NAT --> BEDROCK
    NAT --> COGNITO

    RDS --> RDS_LOGS
    RDS --> ENHANCED

    style S3_EP fill:#2e7d32,color:#fff
    style DDB_EP fill:#2e7d32,color:#fff
    style RDS_EP fill:#ff6b6b,color:#fff,stroke-dasharray: 5 5
```

**Legend:**
- 🆕 New resource added
- 🔧 Configuration changed
- 🗑️ Resource removed
- ✅ Unchanged
