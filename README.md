# Backup Local

Aplicativo desktop para criar backups ZIP de pastas locais, executar cópias manualmente e manter uma rotina automática de retenção.

## Como instalar

Execute `Backup-Local-Setup-2.6.1.exe`, gerado dentro da pasta `dist`. O instalador cria os atalhos do aplicativo e o Backup Local abre sem uma janela de terminal.

Para iniciar em modo de desenvolvimento:

```powershell
npm install
npm start
```

## Recursos

- seleção nativa de múltiplas pastas de origem;
- escolha da pasta de destino;
- backup manual e agendado;
- execução em segundo plano pela bandeja do Windows;
- opção para iniciar silenciosamente junto com o Windows;
- encerramento completo pela interface ou pelo menu da bandeja;
- interface, bandeja, diálogos e notificações em português ou inglês;
- pausa individual de pastas, com registro do tempo pausado;
- proteção do último backup de uma pasta pausada contra limpeza por idade ou espaço;
- nomes personalizados para identificar as origens e seus arquivos ZIP;
- opção para respeitar as regras do `.gitignore` presente na raiz de cada origem;
- escolha do formato de cada novo backup: ZIP, 7z, TAR.ZST ou pasta espelho;
- níveis de compressão rápido, equilibrado e máximo para os formatos compactados;
- mecanismo 7-Zip incluído no aplicativo, sem exigir instalação separada;
- backups 7z de aplicações em execução tentam ler arquivos abertos e preservam o arquivo criado quando apenas itens bloqueados forem omitidos;
- pontos no tempo organizados por pasta, incluindo backups criados antes de uma origem ser renomeada;
- restauração protegida: o estado atual completo é salvo antes de qualquer substituição;
- troca segura da pasta durante a restauração, evitando deixar uma versão parcial em caso de falha;
- execução em processo separado para não congelar a interface;
- cancelamento seguro com remoção de arquivos parciais;
- retenção por idade e espaço livre mínimo;
- histórico local de execuções;
- migração automática de `pastas.txt` e `destino.txt`;
- modo de serviço sem interface.

Somente backups reconhecidos pelos formatos do aplicativo e iniciados por `BackupLocal_` entram na limpeza automática. Outros arquivos e pastas no destino não são alterados.

## Formatos de backup

- **ZIP:** opção padrão e mais compatível com o Windows.
- **7z:** prioriza arquivos menores e melhor taxa de compressão.
- **TAR.ZST:** usa compactação em fluxo de alta velocidade, indicada para pastas grandes.
- **Pasta espelho:** mantém os arquivos diretamente navegáveis, sem compactação.

A configuração selecionada vale para os novos backups. Pontos no tempo antigos continuam reconhecidos e podem ser restaurados mesmo quando foram criados em outro formato. A pasta espelho não usa nível de compressão.

Ao copiar uma aplicação ou servidor em execução, o Windows pode impedir a leitura de algum arquivo bloqueado. No formato 7z, o Backup Local preserva o backup utilizável, marca a execução como concluída com avisos e mostra quais itens não puderam ser lidos. Para uma cópia totalmente consistente de bancos de dados ou mundos de jogos, use também o comando de salvamento do próprio servidor ou interrompa-o durante o backup.

Ao fechar a janela, o aplicativo continua ativo para cumprir os agendamentos. Clique no ícone do Backup Local ao lado do relógio para reabrir, iniciar um backup ou usar **Sair completamente**.

## Modo de serviço

Para executar apenas o agendador, sem abrir a janela:

```powershell
npm run service
```

Para realizar um único backup e encerrar:

```powershell
node backup.js --once
```

## Desenvolvimento

```powershell
npm run check
npm test
```

Para gerar um novo instalador:

```powershell
npm run dist
```

Na versão instalada, as preferências e o histórico ficam em `%APPDATA%\Backup Local`. O destino inicial dos arquivos é `Documentos\Backup Local`. No modo de desenvolvimento, os dados continuam locais ao projeto e ignorados pelo Git.

## Assinatura do Windows

O instalador ainda não possui um certificado comercial Authenticode. Por isso, o Windows pode mostrar “Editor desconhecido” ou uma confirmação do SmartScreen. Isso não afeta o funcionamento, mas uma distribuição pública deve ser assinada com um certificado confiável.
